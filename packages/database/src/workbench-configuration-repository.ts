import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  TRUSTED_WORKBENCH_PANELS,
  canonicalWorkbenchJson,
  workbenchLayoutDocumentSchema,
  type CreateWorkbenchInput,
  type CreateWorkbenchLayoutInput,
  type SaveWorkbenchLayoutInput,
  type SetDefaultWorkbenchLayoutInput,
  type UpdateWorkbenchInput,
  type Workbench,
  type WorkbenchLayout,
  type WorkbenchLayoutDocument,
  type WorkbenchLayoutVersion,
  type WorkbenchPanelPlacement,
  type WorkbenchStatus,
  type WorkbenchVersion,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";
import { appendAuditEventWithClient } from "./audit-event-repository.js";

interface WorkbenchRow {
  readonly id: string;
  readonly owner_principal_id: string;
  readonly name: string;
  readonly status: WorkbenchStatus;
  readonly current_version: number;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface WorkbenchLayoutRow {
  readonly id: string;
  readonly workbench_id: string;
  readonly owner_principal_id: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly is_factory_default: boolean;
  readonly revision: number;
  readonly status: "active" | "archived";
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface WorkbenchPanelInstanceRow {
  readonly id: string;
  readonly layout_id: string;
  readonly plugin_id: string;
  readonly position: number;
  readonly width: number;
  readonly height: number | null;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly panel_status: "active" | "disabled";
  readonly panel_title: string;
  readonly panel_version: string;
  readonly panel_refreshable: boolean;
  readonly panel_min_height: number;
  readonly panel_max_height: number;
}

interface WorkbenchVersionRow {
  readonly id: string;
  readonly workbench_id: string;
  readonly version: number;
  readonly layout_id: string;
  readonly layout_revision: number;
  readonly document: WorkbenchLayoutDocument;
  readonly digest: string;
  readonly created_by_principal_id: string;
  readonly created_at: Date;
}

interface WorkbenchLayoutVersionRow {
  readonly id: string;
  readonly layout_id: string;
  readonly revision: number;
  readonly document: WorkbenchLayoutDocument;
  readonly digest: string;
  readonly changed_by_principal_id: string;
  readonly created_at: Date;
}

interface QueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: T[];
    readonly rowCount: number | null;
  }>;
}

export type WorkbenchConfigurationErrorCode =
  | "workbench_not_found"
  | "workbench_layout_not_found"
  | "workbench_revision_conflict"
  | "workbench_name_conflict"
  | "workbench_layout_name_conflict"
  | "workbench_default_required"
  | "workbench_unknown_panel"
  | "workbench_panel_disabled"
  | "workbench_panel_size_invalid";

export class WorkbenchConfigurationRepositoryError extends Error {
  constructor(
    readonly code: WorkbenchConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkbenchConfigurationRepositoryError";
  }
}

export interface WorkbenchPanelRecord {
  readonly id: string;
  readonly pluginId: string;
  readonly position: number;
  readonly width: number;
  readonly height: number | null;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly panelStatus: "active" | "disabled";
  readonly panelTitle: string;
  readonly panelVersion: string;
  readonly panelRefreshable: boolean;
  readonly panelMinHeight: number;
  readonly panelMaxHeight: number;
}

export interface WorkbenchConfigurationRecord {
  readonly workbench: Workbench;
  readonly layout: WorkbenchLayout;
  readonly layoutVersion: WorkbenchLayoutVersion;
  readonly panels: WorkbenchPanelRecord[];
}

export interface TemplateCopyWorkbenchCandidate {
  readonly workbenchId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

export class WorkbenchConfigurationRepository {
  constructor(private readonly database: Database) {}

  async ensureDefaultWorkbench(actorId: string): Promise<WorkbenchConfigurationRecord> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`workbench-default:${actorId}`],
      );
      const existing = await this.defaultWorkbenchRecordWithClient(
        client,
        actorId,
      );
      if (existing !== undefined) return existing;
      const workbenchId = randomUUID();
      const layoutId = randomUUID();
      await client.query(
        `INSERT INTO workbenches (
           id, owner_principal_id, name, status, current_version, revision,
           created_at, updated_at
         ) VALUES ($1, $2, 'My Workbench', 'active', 1, 1, NOW(), NOW())`,
        [workbenchId, actorId],
      );
      await this.insertLayoutWithClient(client, {
        actorId,
        workbenchId,
        layoutId,
        workbenchVersion: 1,
        name: "Default",
        document: await this.factoryDocumentWithClient(client),
        isDefault: true,
        isFactoryDefault: true,
      });
      return (await this.requireWorkbenchRecordWithClient(
        client,
        actorId,
        workbenchId,
      ))!;
    });
  }

  async listWorkbenches(actorId: string): Promise<Workbench[]> {
    const result = await this.database.query<WorkbenchRow>(
      `SELECT *
       FROM workbenches
       WHERE owner_principal_id = $1 AND status = 'active'
       ORDER BY updated_at DESC, created_at, id`,
      [actorId],
    );
    return result.rows.map(workbenchFromRow);
  }

  async getDefaultWorkbench(
    actorId: string,
  ): Promise<WorkbenchConfigurationRecord> {
    const result = await this.database.query<WorkbenchRow>(
      `SELECT workbench.*
       FROM workbenches AS workbench
       JOIN workbench_layouts AS layout
         ON layout.workbench_id = workbench.id
        AND layout.owner_principal_id = workbench.owner_principal_id
        AND layout.status = 'active'
       WHERE workbench.owner_principal_id = $1
         AND workbench.status = 'active'
       ORDER BY layout.is_default DESC, workbench.updated_at DESC, workbench.id
       LIMIT 1`,
      [actorId],
    );
    const row = result.rows[0];
    if (row === undefined) return this.ensureDefaultWorkbench(actorId);
    const record = await this.getWorkbench(actorId, row.id);
    if (record === undefined) return this.ensureDefaultWorkbench(actorId);
    return record;
  }

  async getWorkbench(
    actorId: string,
    workbenchId: string,
  ): Promise<WorkbenchConfigurationRecord | undefined> {
    return this.requireWorkbenchRecordWithClient(
      this.database,
      actorId,
      workbenchId,
      false,
    );
  }

  async createWorkbench(
    actorId: string,
    input: CreateWorkbenchInput,
    auditMetadata: Readonly<Record<string, unknown>> = {},
  ): Promise<WorkbenchConfigurationRecord> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`workbench-create:${actorId}`],
      );
      const workbenchId = randomUUID();
      const layoutId = randomUUID();
      const existingDefault = await client.query(
        `SELECT 1
         FROM workbench_layouts
         WHERE owner_principal_id = $1
           AND is_default
           AND status = 'active'
         LIMIT 1`,
        [actorId],
      );
      try {
        await client.query(
          `INSERT INTO workbenches (
             id, owner_principal_id, name, status, current_version, revision,
             created_at, updated_at
           ) VALUES ($1, $2, $3, 'active', 1, 1, NOW(), NOW())`,
          [workbenchId, actorId, input.name],
        );
      } catch (error) {
        throw translateWorkbenchConstraint(error, "workbench_name_conflict");
      }
      const document =
        input.template ?? (await this.factoryDocumentWithClient(client));
      await this.insertLayoutWithClient(client, {
        actorId,
        workbenchId,
        layoutId,
        workbenchVersion: 1,
        name: "Default",
        document,
        isDefault: existingDefault.rowCount === 0,
        isFactoryDefault: false,
      });
      await appendAuditEventWithClient(client, {
        action: "workbench.created",
        actorPrincipalId: actorId,
        metadata: {
          workbenchId,
          layoutId,
          panelCount: document.panels.length,
          source: input.template === undefined ? "factory" : "template",
          ...auditMetadata,
        },
      });
      return (await this.requireWorkbenchRecordWithClient(
        client,
        actorId,
        workbenchId,
      ))!;
    });
  }

  async listTemplateCopyCandidates(
    actorId: string,
    input: {
      readonly templateId?: string;
      readonly olderThanSeconds: number;
    },
  ): Promise<TemplateCopyWorkbenchCandidate[]> {
    const result = await this.database.query<{
      readonly workbench_id: string;
      readonly template_id: string;
      readonly template_version: number;
      readonly idempotency_key: string;
      readonly created_at: Date;
    }>(
      `SELECT DISTINCT
         event.metadata ->> 'workbenchId' AS workbench_id,
         event.metadata ->> 'templateId' AS template_id,
         (event.metadata ->> 'templateVersion')::integer AS template_version,
         event.metadata ->> 'idempotencyKey' AS idempotency_key,
         event.created_at
       FROM identity_audit_events AS event
       JOIN workbenches AS workbench
         ON workbench.id::text = event.metadata ->> 'workbenchId'
        AND workbench.owner_principal_id = $1
        AND workbench.status = 'active'
       WHERE event.action = 'workbench.created'
         AND event.metadata ->> 'source' = 'market-template-copy'
         AND event.metadata ->> 'templateId' IS NOT NULL
         AND ($2::uuid IS NULL OR event.metadata ->> 'templateId' = $2::text)
         AND event.created_at <= NOW() - ($3::text || ' seconds')::interval
       ORDER BY event.created_at, workbench_id`,
      [
        actorId,
        input.templateId ?? null,
        Math.max(0, Math.floor(input.olderThanSeconds)),
      ],
    );
    return result.rows.map((row) => ({
      workbenchId: row.workbench_id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    }));
  }

  async compensateTemplateCopyCandidate(
    actorId: string,
    candidate: TemplateCopyWorkbenchCandidate,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const workbench = await client.query(
        `SELECT 1
         FROM workbenches
         WHERE id = $1
           AND owner_principal_id = $2
           AND status = 'active'
         FOR UPDATE`,
        [candidate.workbenchId, actorId],
      );
      if (workbench.rowCount === 0) return false;
      const receipt = await client.query(
        `SELECT 1
         FROM market_template_copies
         WHERE workbench_id = $1`,
        [candidate.workbenchId],
      );
      if (receipt.rowCount !== 0) return false;
      await client.query(
        `UPDATE workbench_layouts
         SET status = 'archived',
             is_default = FALSE,
             revision = revision + 1,
             updated_at = NOW()
         WHERE workbench_id = $1
           AND owner_principal_id = $2
           AND status = 'active'`,
        [candidate.workbenchId, actorId],
      );
      await client.query(
        `UPDATE workbenches
         SET status = 'archived',
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1 AND owner_principal_id = $2`,
        [candidate.workbenchId, actorId],
      );
      await appendAuditEventWithClient(client, {
        action: "market.template.copy.compensated",
        actorPrincipalId: actorId,
        metadata: {
          templateId: candidate.templateId,
          templateVersion: candidate.templateVersion,
          workbenchId: candidate.workbenchId,
          idempotencyKey: candidate.idempotencyKey,
          reason: "template_copy_receipt_missing",
        },
      });
      return true;
    });
  }

  async updateWorkbench(
    actorId: string,
    workbenchId: string,
    input: UpdateWorkbenchInput,
  ): Promise<WorkbenchConfigurationRecord> {
    return this.database.transaction(async (client) => {
      const current = await this.lockWorkbenchWithClient(
        client,
        actorId,
        workbenchId,
      );
      if (current.revision !== input.expectedRevision) {
        throw new WorkbenchConfigurationRepositoryError(
          "workbench_revision_conflict",
          "Workbench revision changed",
        );
      }
      try {
        await client.query(
          `UPDATE workbenches
           SET name = COALESCE($3, name),
               status = COALESCE($4, status),
               revision = revision + 1,
               updated_at = NOW()
           WHERE id = $1 AND owner_principal_id = $2`,
          [
            workbenchId,
            actorId,
            input.name ?? null,
            input.status ?? null,
          ],
        );
      } catch (error) {
        throw translateWorkbenchConstraint(error, "workbench_name_conflict");
      }
      await appendAuditEventWithClient(client, {
        action: "workbench.updated",
        actorPrincipalId: actorId,
        metadata: {
          workbenchId,
          revision: current.revision + 1,
          name: input.name ?? current.name,
          status: input.status ?? current.status,
        },
      });
      const updated = await this.requireWorkbenchRecordWithClient(
        client,
        actorId,
        workbenchId,
        false,
      );
      if (updated === undefined) {
        throw new WorkbenchConfigurationRepositoryError(
          "workbench_not_found",
          "Workbench not found",
        );
      }
      return updated;
    });
  }

  async createLayout(
    actorId: string,
    workbenchId: string,
    input: CreateWorkbenchLayoutInput,
  ): Promise<WorkbenchConfigurationRecord> {
    return this.database.transaction(async (client) => {
      const workbench = await this.lockWorkbenchWithClient(
        client,
        actorId,
        workbenchId,
      );
      if (input.makeDefault) {
        await client.query(
          `UPDATE workbench_layouts
           SET is_default = FALSE, updated_at = NOW()
           WHERE owner_principal_id = $1
             AND is_default
             AND status = 'active'`,
          [actorId],
        );
      }
      const layoutId = randomUUID();
      const workbenchVersion = workbench.current_version + 1;
      try {
        await this.insertLayoutWithClient(client, {
          actorId,
          workbenchId,
          layoutId,
          workbenchVersion,
          name: input.name,
          document: input.document,
          isDefault: input.makeDefault,
          isFactoryDefault: false,
        });
      } catch (error) {
        throw translateWorkbenchConstraint(
          error,
          "workbench_layout_name_conflict",
        );
      }
      await client.query(
        `UPDATE workbenches
         SET current_version = $3,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1 AND owner_principal_id = $2`,
        [workbenchId, actorId, workbenchVersion],
      );
      await appendAuditEventWithClient(client, {
        action: "workbench.layout.created",
        actorPrincipalId: actorId,
        metadata: {
          workbenchId,
          layoutId,
          name: input.name,
          isDefault: input.makeDefault,
        },
      });
      return (await this.requireWorkbenchRecordWithClient(
        client,
        actorId,
        workbenchId,
      ))!;
    });
  }

  async saveLayout(
    actorId: string,
    workbenchId: string,
    layoutId: string,
    input: SaveWorkbenchLayoutInput,
  ): Promise<WorkbenchConfigurationRecord> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`workbench-layout:${layoutId}`],
      );
      const workbench = await this.lockWorkbenchWithClient(
        client,
        actorId,
        workbenchId,
      );
      const layout = await this.lockLayoutWithClient(
        client,
        actorId,
        workbenchId,
        layoutId,
      );
      if (layout.revision !== input.expectedRevision) {
        throw new WorkbenchConfigurationRepositoryError(
          "workbench_revision_conflict",
          "Workbench layout revision changed",
        );
      }
      const document = await this.replaceLayoutDocumentWithClient(
        client,
        layoutId,
        input.document,
      );
      const nextRevision = layout.revision + 1;
      try {
        await client.query(
          `UPDATE workbench_layouts
           SET name = COALESCE($4, name),
               revision = $5,
               updated_at = NOW()
           WHERE id = $1 AND workbench_id = $2 AND owner_principal_id = $3`,
          [
            layoutId,
            workbenchId,
            actorId,
            input.name ?? null,
            nextRevision,
          ],
        );
      } catch (error) {
        throw translateWorkbenchConstraint(
          error,
          "workbench_layout_name_conflict",
        );
      }
      const digest = workbenchDocumentDigest(document);
      await client.query(
        `INSERT INTO workbench_layout_versions (
           id, layout_id, revision, document, digest, changed_by_principal_id,
           created_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())`,
        [
          randomUUID(),
          layoutId,
          nextRevision,
          JSON.stringify(document),
          digest,
          actorId,
        ],
      );
      const workbenchVersion = workbench.current_version + 1;
      await client.query(
        `INSERT INTO workbench_versions (
           id, workbench_id, version, layout_id, layout_revision, document,
           digest, created_by_principal_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())`,
        [
          randomUUID(),
          workbenchId,
          workbenchVersion,
          layoutId,
          nextRevision,
          JSON.stringify(document),
          digest,
          actorId,
        ],
      );
      await client.query(
        `UPDATE workbenches
         SET current_version = $3,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1 AND owner_principal_id = $2`,
        [workbenchId, actorId, workbenchVersion],
      );
      await appendAuditEventWithClient(client, {
        action: "workbench.layout.saved",
        actorPrincipalId: actorId,
        metadata: {
          workbenchId,
          layoutId,
          layoutRevision: nextRevision,
          workbenchVersion,
          digest,
          panelCount: document.panels.length,
        },
      });
      return (await this.requireWorkbenchRecordWithClient(
        client,
        actorId,
        workbenchId,
      ))!;
    });
  }

  async setDefaultLayout(
    actorId: string,
    workbenchId: string,
    layoutId: string,
    input: SetDefaultWorkbenchLayoutInput,
  ): Promise<WorkbenchConfigurationRecord> {
    return this.database.transaction(async (client) => {
      const workbench = await this.lockWorkbenchWithClient(
        client,
        actorId,
        workbenchId,
      );
      const layout = await this.lockLayoutWithClient(
        client,
        actorId,
        workbenchId,
        layoutId,
      );
      if (layout.revision !== input.expectedRevision) {
        throw new WorkbenchConfigurationRepositoryError(
          "workbench_revision_conflict",
          "Workbench layout revision changed",
        );
      }
      await client.query(
        `UPDATE workbench_layouts
         SET is_default = FALSE, updated_at = NOW()
         WHERE owner_principal_id = $1
           AND is_default
           AND status = 'active'
           AND id <> $2`,
        [actorId, layoutId],
      );
      await client.query(
        `UPDATE workbench_layouts
         SET is_default = TRUE, updated_at = NOW()
         WHERE id = $1 AND workbench_id = $2 AND owner_principal_id = $3`,
        [layoutId, workbenchId, actorId],
      );
      await appendAuditEventWithClient(client, {
        action: "workbench.layout.default_set",
        actorPrincipalId: actorId,
        metadata: {
          workbenchId,
          layoutId,
          workbenchRevision: workbench.revision,
        },
      });
      return (await this.requireWorkbenchRecordWithClient(
        client,
        actorId,
        workbenchId,
      ))!;
    });
  }

  async listWorkbenchVersions(
    actorId: string,
    workbenchId: string,
  ): Promise<WorkbenchVersion[]> {
    await this.lockWorkbenchOwnerRead(actorId, workbenchId);
    const result = await this.database.query<WorkbenchVersionRow>(
      `SELECT *
       FROM workbench_versions
       WHERE workbench_id = $1
       ORDER BY version DESC`,
      [workbenchId],
    );
    return result.rows.map(workbenchVersionFromRow);
  }

  async listLayoutVersions(
    actorId: string,
    workbenchId: string,
    layoutId: string,
  ): Promise<WorkbenchLayoutVersion[]> {
    const layout = await this.database.query(
      `SELECT 1
       FROM workbench_layouts
       WHERE id = $1 AND workbench_id = $2 AND owner_principal_id = $3`,
      [layoutId, workbenchId, actorId],
    );
    if (layout.rowCount === 0) {
      throw new WorkbenchConfigurationRepositoryError(
        "workbench_layout_not_found",
        "Workbench layout not found",
      );
    }
    const result = await this.database.query<WorkbenchLayoutVersionRow>(
      `SELECT *
       FROM workbench_layout_versions
       WHERE layout_id = $1
       ORDER BY revision DESC`,
      [layoutId],
    );
    return result.rows.map(workbenchLayoutVersionFromRow);
  }

  async getPanelRecord(
    actorId: string,
    workbenchId: string,
    instanceId: string,
  ): Promise<
    | {
        readonly workbench: Workbench;
        readonly layout: WorkbenchLayout;
        readonly panel: WorkbenchPanelRecord;
      }
    | undefined
  > {
    const record = await this.getWorkbench(actorId, workbenchId);
    if (record === undefined) return undefined;
    const panel = record.panels.find((item) => item.id === instanceId);
    if (panel === undefined) return undefined;
    return {
      workbench: record.workbench,
      layout: record.layout,
      panel,
    };
  }

  private async defaultWorkbenchRecordWithClient(
    executor: QueryExecutor,
    actorId: string,
  ): Promise<WorkbenchConfigurationRecord | undefined> {
    const result = await executor.query<WorkbenchRow>(
      `SELECT workbench.*
       FROM workbenches AS workbench
       JOIN workbench_layouts AS layout
         ON layout.workbench_id = workbench.id
        AND layout.is_default
        AND layout.status = 'active'
       WHERE workbench.owner_principal_id = $1
         AND workbench.status = 'active'
       ORDER BY workbench.updated_at DESC, workbench.id
       LIMIT 1`,
      [actorId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : this.requireWorkbenchRecordWithClient(
          executor,
          actorId,
          row.id,
          false,
        );
  }

  private async requireWorkbenchRecordWithClient(
    executor: QueryExecutor,
    actorId: string,
    workbenchId: string,
    required = true,
  ): Promise<WorkbenchConfigurationRecord | undefined> {
    const workbenchResult = await executor.query<WorkbenchRow>(
      `SELECT *
       FROM workbenches
       WHERE id = $1 AND owner_principal_id = $2`,
      [workbenchId, actorId],
    );
    const workbenchRow = workbenchResult.rows[0];
    if (workbenchRow === undefined) {
      if (!required) return undefined;
      throw new WorkbenchConfigurationRepositoryError(
        "workbench_not_found",
        "Workbench not found",
      );
    }
    const layoutResult = await executor.query<WorkbenchLayoutRow>(
      `SELECT *
       FROM workbench_layouts
       WHERE workbench_id = $1
         AND owner_principal_id = $2
         AND status = 'active'
       ORDER BY is_default DESC, updated_at DESC, id
       LIMIT 1`,
      [workbenchId, actorId],
    );
    const layoutRow = layoutResult.rows[0];
    if (layoutRow === undefined) {
      if (!required) return undefined;
      throw new WorkbenchConfigurationRepositoryError(
        "workbench_layout_not_found",
        "Workbench layout not found",
      );
    }
    const panels = await this.listPanelRecordsWithClient(
      executor,
      layoutRow.id,
    );
    const document = layoutDocumentFromPanels(panels);
    const versionResult = await executor.query<WorkbenchLayoutVersionRow>(
      `SELECT *
       FROM workbench_layout_versions
       WHERE layout_id = $1
         AND revision = $2`,
      [layoutRow.id, layoutRow.revision],
    );
    const versionRow = versionResult.rows[0];
    if (versionRow === undefined) {
      if (!required) return undefined;
      throw new WorkbenchConfigurationRepositoryError(
        "workbench_layout_not_found",
        "Workbench version head not found",
      );
    }
    return {
      workbench: workbenchFromRow(workbenchRow),
      layout: workbenchLayoutFromRow(layoutRow, document),
      layoutVersion: workbenchLayoutVersionFromRow(versionRow),
      panels,
    };
  }

  private async listPanelRecordsWithClient(
    executor: QueryExecutor,
    layoutId: string,
  ): Promise<WorkbenchPanelRecord[]> {
    const result = await executor.query<WorkbenchPanelInstanceRow>(
      `SELECT
         instance.id,
         instance.layout_id,
         instance.plugin_id,
         instance.position,
         instance.width,
         instance.height,
         instance.config,
         instance.enabled,
         panel.status AS panel_status,
         panel.title AS panel_title,
         panel.version AS panel_version,
         panel.refreshable AS panel_refreshable,
         panel.min_height AS panel_min_height,
         panel.max_height AS panel_max_height
       FROM workbench_panel_instances AS instance
       JOIN workbench_panels AS panel ON panel.plugin_id = instance.plugin_id
       WHERE instance.layout_id = $1
       ORDER BY instance.position, instance.plugin_id`,
      [layoutId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      pluginId: row.plugin_id,
      position: row.position,
      width: row.width,
      height: row.height,
      config: row.config,
      enabled: row.enabled,
      panelStatus: row.panel_status,
      panelTitle: row.panel_title,
      panelVersion: row.panel_version,
      panelRefreshable: row.panel_refreshable,
      panelMinHeight: row.panel_min_height,
      panelMaxHeight: row.panel_max_height,
    }));
  }

  private async insertLayoutWithClient(
    client: PoolClient,
    input: {
      readonly actorId: string;
      readonly workbenchId: string;
      readonly layoutId: string;
      readonly workbenchVersion: number;
      readonly name: string;
      readonly document: WorkbenchLayoutDocument;
      readonly isDefault: boolean;
      readonly isFactoryDefault: boolean;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO workbench_layouts (
         id, workbench_id, owner_principal_id, name, is_default,
         is_factory_default, revision, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'active', NOW(), NOW())`,
      [
        input.layoutId,
        input.workbenchId,
        input.actorId,
        input.name,
        input.isDefault,
        input.isFactoryDefault,
      ],
    );
    const document = await this.replaceLayoutDocumentWithClient(
      client,
      input.layoutId,
      input.document,
      false,
    );
    const digest = workbenchDocumentDigest(document);
    await client.query(
      `INSERT INTO workbench_layout_versions (
         id, layout_id, revision, document, digest, changed_by_principal_id,
         created_at
       ) VALUES ($1, $2, 1, $3::jsonb, $4, $5, NOW())`,
      [
        randomUUID(),
        input.layoutId,
        JSON.stringify(document),
        digest,
        input.actorId,
      ],
    );
    await client.query(
      `INSERT INTO workbench_versions (
         id, workbench_id, version, layout_id, layout_revision, document,
         digest, created_by_principal_id, created_at
       ) VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6, $7, NOW())`,
      [
        randomUUID(),
        input.workbenchId,
        input.workbenchVersion,
        input.layoutId,
        JSON.stringify(document),
        digest,
        input.actorId,
      ],
    );
  }

  private async factoryDocumentWithClient(
    client: PoolClient,
  ): Promise<WorkbenchLayoutDocument> {
    const active = await client.query<{ plugin_id: string }>(
      "SELECT plugin_id FROM workbench_panels WHERE status = 'active'",
    );
    const activePanelIds = new Set(active.rows.map((row) => row.plugin_id));
    return {
      version: 1,
      panels: factoryWorkbenchDocument().panels
        .filter((panel) => activePanelIds.has(panel.pluginId))
        .map((panel, position) => ({ ...panel, position })),
    };
  }

  private async replaceLayoutDocumentWithClient(
    client: PoolClient,
    layoutId: string,
    input: WorkbenchLayoutDocument,
    preserveInstanceIds = true,
  ): Promise<WorkbenchLayoutDocument> {
    const parsed = workbenchLayoutDocumentSchema.parse(input);
    const panels = [...parsed.panels]
      .sort((left, right) => left.position - right.position)
      .map((panel) => ({
        ...panel,
        instanceId:
          (preserveInstanceIds ? panel.instanceId : undefined) ?? randomUUID(),
      }));
    for (const panel of panels) {
      const registered = await client.query<{
        status: "active" | "disabled";
        min_height: number;
        max_height: number;
      }>(
        `SELECT status, min_height, max_height
         FROM workbench_panels
         WHERE plugin_id = $1`,
        [panel.pluginId],
      );
      const row = registered.rows[0];
      if (row === undefined) {
        throw new WorkbenchConfigurationRepositoryError(
          "workbench_unknown_panel",
          `Unknown Workbench panel ${panel.pluginId}`,
        );
      }
      if (row.status !== "active") {
        throw new WorkbenchConfigurationRepositoryError(
          "workbench_panel_disabled",
          `Workbench panel ${panel.pluginId} is disabled`,
        );
      }
      if (
        panel.height !== null &&
        (panel.height < row.min_height || panel.height > row.max_height)
      ) {
        throw new WorkbenchConfigurationRepositoryError(
          "workbench_panel_size_invalid",
          `Workbench panel ${panel.pluginId} height is outside its trusted range`,
        );
      }
    }
    await client.query(
      "DELETE FROM workbench_panel_instances WHERE layout_id = $1",
      [layoutId],
    );
    for (const panel of panels) {
      await client.query(
        `INSERT INTO workbench_panel_instances (
           id, layout_id, plugin_id, position, width, height, config, enabled,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW()
         )`,
        [
          panel.instanceId,
          layoutId,
          panel.pluginId,
          panel.position,
          panel.width,
          panel.height,
          JSON.stringify(panel.config),
          panel.enabled,
        ],
      );
    }
    return {
      version: 1,
      panels,
    };
  }

  private async lockWorkbenchWithClient(
    client: PoolClient,
    actorId: string,
    workbenchId: string,
  ): Promise<WorkbenchRow> {
    const result = await client.query<WorkbenchRow>(
      `SELECT *
       FROM workbenches
       WHERE id = $1 AND owner_principal_id = $2
       FOR UPDATE`,
      [workbenchId, actorId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkbenchConfigurationRepositoryError(
        "workbench_not_found",
        "Workbench not found",
      );
    }
    return row;
  }

  private async lockLayoutWithClient(
    client: PoolClient,
    actorId: string,
    workbenchId: string,
    layoutId: string,
  ): Promise<WorkbenchLayoutRow> {
    const result = await client.query<WorkbenchLayoutRow>(
      `SELECT *
       FROM workbench_layouts
       WHERE id = $1
         AND workbench_id = $2
         AND owner_principal_id = $3
         AND status = 'active'
       FOR UPDATE`,
      [layoutId, workbenchId, actorId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkbenchConfigurationRepositoryError(
        "workbench_layout_not_found",
        "Workbench layout not found",
      );
    }
    return row;
  }

  private async lockWorkbenchOwnerRead(
    actorId: string,
    workbenchId: string,
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT 1 FROM workbenches
       WHERE id = $1 AND owner_principal_id = $2`,
      [workbenchId, actorId],
    );
    if (result.rowCount === 0) {
      throw new WorkbenchConfigurationRepositoryError(
        "workbench_not_found",
        "Workbench not found",
      );
    }
  }
}

function workbenchFromRow(row: WorkbenchRow): Workbench {
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    status: row.status,
    currentVersion: row.current_version,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function workbenchLayoutFromRow(
  row: WorkbenchLayoutRow,
  document: WorkbenchLayoutDocument,
): WorkbenchLayout {
  return {
    id: row.id,
    workbenchId: row.workbench_id,
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    isDefault: row.is_default,
    isFactoryDefault: row.is_factory_default,
    revision: row.revision,
    status: row.status,
    document,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function workbenchVersionFromRow(row: WorkbenchVersionRow): WorkbenchVersion {
  return {
    id: row.id,
    workbenchId: row.workbench_id,
    version: row.version,
    layoutId: row.layout_id,
    layoutRevision: row.layout_revision,
    document: row.document,
    digest: row.digest,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
  };
}

function workbenchLayoutVersionFromRow(
  row: WorkbenchLayoutVersionRow,
): WorkbenchLayoutVersion {
  return {
    id: row.id,
    layoutId: row.layout_id,
    revision: row.revision,
    document: row.document,
    digest: row.digest,
    changedByPrincipalId: row.changed_by_principal_id,
    createdAt: row.created_at.toISOString(),
  };
}

function layoutDocumentFromPanels(
  panels: readonly WorkbenchPanelRecord[],
): WorkbenchLayoutDocument {
  return {
    version: 1,
    panels: panels.map((panel): WorkbenchPanelPlacement => ({
      instanceId: panel.id,
      pluginId: panel.pluginId,
      position: panel.position,
      width: panel.width,
      height: panel.height,
      config: panel.config,
      enabled: panel.enabled,
    })),
  };
}

export function factoryWorkbenchDocument(): WorkbenchLayoutDocument {
  return {
    version: 1,
    panels: TRUSTED_WORKBENCH_PANELS.filter(
      (panel) => !panel.requiresEntitlement,
    ).map((panel, position) => ({
      pluginId: panel.pluginId,
      position,
      width: panel.defaultWidth,
      height: null,
      config: {},
      enabled: true,
    })),
  };
}

export function workbenchDocumentDigest(
  document: WorkbenchLayoutDocument,
): string {
  return createHash("sha256")
    .update(canonicalWorkbenchJson(document))
    .digest("hex");
}

function translateWorkbenchConstraint(
  error: unknown,
  code: WorkbenchConfigurationErrorCode,
): WorkbenchConfigurationRepositoryError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  ) {
    const constraint =
      "constraint" in error &&
      typeof (error as { constraint?: unknown }).constraint === "string"
        ? ` (${(error as { constraint: string }).constraint})`
        : "";
    return new WorkbenchConfigurationRepositoryError(
      code,
      `Workbench configuration conflicts with an existing record${constraint}`,
    );
  }
  return error instanceof WorkbenchConfigurationRepositoryError
    ? error
    : new WorkbenchConfigurationRepositoryError(code, "Workbench write failed");
}
