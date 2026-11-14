import { randomUUID } from "node:crypto";
import type {
  CreateDataAgentMessageValue,
  CreateDataConnectionValue,
  CreateDataPolicyValue,
  CreateDataPolicyVersionValue,
  CreateDatasetColumnValue,
  CreateDatasetValue,
  CreateSemanticMetricValue,
  CreateSemanticMetricVersionValue,
  DataAgentAnswer,
  DataAgentContextRef,
  DataAgentContextRefKind,
  DataAgentConversation,
  DataAgentMessage,
  DataConnection,
  DataPolicy,
  DataPolicyVersion,
  DataPolicyVersionContentValue,
  DataQueryMode,
  DataRowFilter,
  Dataset,
  DatasetColumn,
  DatasetColumnType,
  QueryPermissionSummary,
  QueryResult,
  QueryRun,
  QueryRunStatus,
  SemanticMetric,
  SemanticMetricAggregation,
  SemanticMetricVersion,
  SemanticMetricVersionContentValue,
} from "@pluginmax/contracts";
import type { PoolClient, QueryResultRow } from "pg";
import type { Database } from "./database.js";

interface Queryable {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: T[];
    readonly rowCount: number | null;
  }>;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  provider: "fixture";
  status: "active" | "disabled";
  revision: number;
  allowed_runtime_profile_ids: string[];
  max_rows: number;
  timeout_ms: number;
  data_cutoff_at: Date | null;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface DatasetRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  project_id: string;
  dataset_key: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  revision: number;
  max_rows: number;
  timeout_ms: number;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface ColumnRow {
  id: string;
  dataset_id: string;
  name: string;
  data_type: DatasetColumnType;
  position: number;
  sensitive: boolean;
  created_at: Date;
}

interface MetricRow {
  id: string;
  dataset_id: string;
  metric_key: string;
  title: string;
  current_version: number;
  status: "active" | "retired";
  revision: number;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface MetricVersionRow {
  id: string;
  metric_id: string;
  version: number;
  aggregation: SemanticMetricAggregation;
  column_name: string;
  description: string;
  format: "integer" | "decimal" | "text";
  digest: string;
  created_by_principal_id: string;
  created_at: Date;
}

type MetricBundleRow = MetricRow &
  MetricVersionRow & {
    version_row_id: string;
    version_description: string;
    version_created_by_principal_id: string;
    version_created_at: Date;
  };

interface PolicyRow {
  id: string;
  dataset_id: string;
  scope_type: "workspace" | "project";
  scope_id: string;
  current_version: number;
  status: "active" | "retired";
  revision: number;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface PolicyVersionRow {
  id: string;
  policy_id: string;
  version: number;
  row_filters: DataRowFilter[];
  allowed_columns: string[];
  denied_columns: string[];
  max_rows: number;
  timeout_ms: number;
  data_cutoff_at: Date | null;
  digest: string;
  created_by_principal_id: string;
  created_at: Date;
}

type PolicyBundleRow = PolicyRow &
  PolicyVersionRow & {
    version_row_id: string;
    version_created_by_principal_id: string;
    version_created_at: Date;
  };

interface RunContextRow {
  id: string;
  project_id: string;
  agent_id: string;
  agent_principal_id: string | null;
  runtime_profile_id: string | null;
  context_pack_id: string | null;
  skill_snapshot_digest: string | null;
  initiated_by_principal_id: string | null;
}

interface ConversationRow {
  id: string;
  project_id: string;
  run_id: string;
  context_pack_id: string | null;
  skill_snapshot_digest: string | null;
  runtime_profile_id: string;
  requester_principal_id: string;
  agent_id: string;
  agent_principal_id: string;
  title: string;
  status: "active" | "archived";
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sequence: string | number;
  role: "user" | "agent" | "system";
  content: string;
  query_run_id: string | null;
  created_at: Date;
}

interface ContextRefRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  kind: DataAgentContextRefKind;
  ref_id: string;
  version: number | null;
  digest: string | null;
  cutoff_at: Date | null;
  created_at: Date;
}

interface QueryRunRow {
  id: string;
  conversation_id: string;
  project_id: string;
  workspace_id: string;
  run_id: string;
  context_pack_id: string | null;
  skill_snapshot_digest: string | null;
  connection_id: string;
  connection_version: number;
  dataset_id: string;
  dataset_version: number;
  metric_id: string | null;
  metric_version: number | null;
  runtime_profile_id: string;
  mode: DataQueryMode;
  query_spec: Record<string, unknown>;
  requester_principal_id: string;
  agent_principal_id: string;
  row_filters: DataRowFilter[];
  denied_columns: string[];
  allowed_columns: string[];
  max_rows: number;
  timeout_ms: number;
  data_cutoff_at: Date | null;
  permission_summary: QueryPermissionSummary;
  policy_snapshot: Array<{
    policyId: string;
    versionId: string;
    version: number;
    digest: string;
  }>;
  status: QueryRunStatus;
  scan_count: string | number | null;
  row_count: string | number | null;
  result_digest: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface FabricQueryResultRow {
  query_run_id: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  digest: string;
  created_at: Date;
}

interface AnswerRow {
  id: string;
  conversation_id: string;
  message_id: string;
  project_id: string;
  run_id: string;
  context_pack_id: string | null;
  skill_snapshot_digest: string | null;
  requester_principal_id: string;
  agent_principal_id: string;
  project_report_id: string | null;
  content: string;
  digest: string;
  created_at: Date;
}

export interface DataPolicyBundle {
  readonly policy: DataPolicy;
  readonly version: DataPolicyVersion;
}

export interface DatasetQueryBundle {
  readonly connection: DataConnection;
  readonly dataset: Dataset;
  readonly columns: DatasetColumn[];
  readonly metrics: Array<{
    readonly metric: SemanticMetric;
    readonly version: SemanticMetricVersion;
  }>;
  readonly policies: DataPolicyBundle[];
}

export interface DataFabricRunContext {
  readonly runId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly agentPrincipalId: string;
  readonly runtimeProfileId: string;
  readonly contextPackId: string | null;
  readonly skillSnapshotDigest: string | null;
  readonly initiatedByPrincipalId: string | null;
}

export interface ProjectReportReference {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly digest: string;
  readonly cutoffAt: Date | null;
}

export interface CreateQueryRunRecordInput {
  readonly conversation: DataAgentConversation;
  readonly connection: DataConnection;
  readonly dataset: Dataset;
  readonly metric: SemanticMetric | null;
  readonly metricVersion: SemanticMetricVersion | null;
  readonly mode: DataQueryMode;
  readonly querySpec: Record<string, unknown>;
  readonly rowFilters: DataRowFilter[];
  readonly deniedColumns: string[];
  readonly allowedColumns: string[];
  readonly maxRows: number;
  readonly timeoutMs: number;
  readonly dataCutoffAt: string | null;
  readonly permissionSummary: QueryPermissionSummary;
  readonly policies: DataPolicyBundle[];
}

export class DataFabricRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "DataFabricRepositoryError";
  }
}

function connectionFromRow(row: ConnectionRow): DataConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    revision: row.revision,
    allowedRuntimeProfileIds: row.allowed_runtime_profile_ids,
    maxRows: row.max_rows,
    timeoutMs: row.timeout_ms,
    dataCutoffAt: row.data_cutoff_at?.toISOString() ?? null,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function datasetFromRow(row: DatasetRow): Dataset {
  return {
    id: row.id,
    connectionId: row.connection_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    key: row.dataset_key,
    name: row.name,
    description: row.description,
    status: row.status,
    revision: row.revision,
    maxRows: row.max_rows,
    timeoutMs: row.timeout_ms,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function columnFromRow(row: ColumnRow): DatasetColumn {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    name: row.name,
    dataType: row.data_type,
    position: row.position,
    sensitive: row.sensitive,
    createdAt: row.created_at.toISOString(),
  };
}

function metricFromRow(row: MetricRow): SemanticMetric {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    key: row.metric_key,
    title: row.title,
    currentVersion: row.current_version,
    status: row.status,
    revision: row.revision,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function metricVersionFromRow(row: MetricVersionRow): SemanticMetricVersion {
  return {
    id: row.id,
    metricId: row.metric_id,
    version: row.version,
    aggregation: row.aggregation,
    column: row.column_name,
    description: row.description,
    format: row.format,
    digest: row.digest,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
  };
}

function policyFromRow(row: PolicyRow): DataPolicy {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    currentVersion: row.current_version,
    status: row.status,
    revision: row.revision,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function policyVersionFromRow(row: PolicyVersionRow): DataPolicyVersion {
  return {
    id: row.id,
    policyId: row.policy_id,
    version: row.version,
    rowFilters: row.row_filters,
    allowedColumns: row.allowed_columns,
    deniedColumns: row.denied_columns,
    maxRows: row.max_rows,
    timeoutMs: row.timeout_ms,
    dataCutoffAt: row.data_cutoff_at?.toISOString() ?? null,
    digest: row.digest,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
  };
}

function conversationFromRow(row: ConversationRow): DataAgentConversation {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    contextPackId: row.context_pack_id,
    skillSnapshotDigest: row.skill_snapshot_digest,
    runtimeProfileId: row.runtime_profile_id,
    requesterPrincipalId: row.requester_principal_id,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function messageFromRow(row: MessageRow): DataAgentMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    role: row.role,
    content: row.content,
    queryRunId: row.query_run_id,
    createdAt: row.created_at.toISOString(),
  };
}

function contextRefFromRow(row: ContextRefRow): DataAgentContextRef {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: row.kind,
    refId: row.ref_id,
    version: row.version,
    digest: row.digest,
    cutoffAt: row.cutoff_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function queryRunFromRow(row: QueryRunRow): QueryRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    contextPackId: row.context_pack_id,
    skillSnapshotDigest: row.skill_snapshot_digest,
    connectionId: row.connection_id,
    connectionVersion: row.connection_version,
    datasetId: row.dataset_id,
    datasetVersion: row.dataset_version,
    metricId: row.metric_id,
    metricVersion: row.metric_version,
    runtimeProfileId: row.runtime_profile_id,
    mode: row.mode,
    querySpec: row.query_spec,
    requesterPrincipalId: row.requester_principal_id,
    agentPrincipalId: row.agent_principal_id,
    rowFilters: row.row_filters,
    deniedColumns: row.denied_columns,
    allowedColumns: row.allowed_columns,
    maxRows: row.max_rows,
    timeoutMs: row.timeout_ms,
    dataCutoffAt: row.data_cutoff_at?.toISOString() ?? null,
    permissionSummary: row.permission_summary,
    policySnapshot: row.policy_snapshot,
    status: row.status,
    scanCount:
      row.scan_count === null ? null : Number(row.scan_count),
    rowCount:
      row.row_count === null ? null : Number(row.row_count),
    resultDigest: row.result_digest,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function queryResultFromRow(row: FabricQueryResultRow): QueryResult {
  return {
    queryRunId: row.query_run_id,
    columns: row.columns,
    rows: row.rows,
    digest: row.digest,
    createdAt: row.created_at.toISOString(),
  };
}

async function withTransaction<T>(
  database: Database,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(operation);
}

async function selectConnection(
  queryable: Queryable,
  connectionId: string,
): Promise<ConnectionRow | undefined> {
  const result = await queryable.query<ConnectionRow>(
    "SELECT * FROM data_connections WHERE id = $1",
    [connectionId],
  );
  return result.rows[0];
}

async function selectDataset(
  queryable: Queryable,
  datasetId: string,
): Promise<DatasetRow | undefined> {
  const result = await queryable.query<DatasetRow>(
    "SELECT * FROM datasets WHERE id = $1",
    [datasetId],
  );
  return result.rows[0];
}

async function listCurrentPolicies(
  queryable: Queryable,
  datasetId: string,
): Promise<DataPolicyBundle[]> {
  const result = await queryable.query<PolicyBundleRow>(
    `SELECT
       policy.*,
       version.id AS version_row_id,
       version.version,
       version.row_filters,
       version.allowed_columns,
       version.denied_columns,
       version.max_rows,
       version.timeout_ms,
       version.data_cutoff_at,
       version.digest,
       version.created_by_principal_id AS version_created_by_principal_id,
       version.created_at AS version_created_at
     FROM data_policies AS policy
     JOIN data_policy_versions AS version
       ON version.policy_id = policy.id
      AND version.version = policy.current_version
     WHERE policy.dataset_id = $1
       AND policy.status = 'active'
     ORDER BY policy.created_at, policy.id`,
    [datasetId],
  );
  return result.rows.map((row: PolicyBundleRow) => {
    const version = policyVersionFromRow({
      ...row,
      id: row.version_row_id,
      policy_id: row.id,
      created_by_principal_id: row.version_created_by_principal_id,
      created_at: row.version_created_at,
    });
    return { policy: policyFromRow(row), version };
  });
}

async function listCurrentMetrics(
  queryable: Queryable,
  datasetId: string,
): Promise<
  Array<{ readonly metric: SemanticMetric; readonly version: SemanticMetricVersion }>
> {
  const result = await queryable.query<MetricBundleRow>(
    `SELECT
       metric.*,
       version.id AS version_row_id,
       version.version,
       version.aggregation,
       version.column_name,
       version.description AS version_description,
       version.format,
       version.digest,
       version.created_by_principal_id AS version_created_by_principal_id,
       version.created_at AS version_created_at
     FROM semantic_metrics AS metric
     JOIN semantic_metric_versions AS version
       ON version.metric_id = metric.id
      AND version.version = metric.current_version
     WHERE metric.dataset_id = $1
       AND metric.status = 'active'
     ORDER BY metric.created_at, metric.id`,
    [datasetId],
  );
  return result.rows.map((row: MetricBundleRow) => ({
    metric: metricFromRow(row),
    version: metricVersionFromRow({
      ...row,
      id: row.version_row_id,
      metric_id: row.id,
      description: row.version_description,
      created_by_principal_id: row.version_created_by_principal_id,
      created_at: row.version_created_at,
    }),
  }));
}

export class DataFabricRepository {
  constructor(private readonly database: Database) {}

  async featureMode(): Promise<string | null> {
    const result = await this.database.query<{ mode: string }>(
      `SELECT mode
       FROM feature_flag_settings
       WHERE flag_key = 'data_fabric'
         AND scope_type = 'platform'
         AND scope_id = 'platform'`,
    );
    return result.rows[0]?.mode ?? null;
  }

  async hasGuestRole(principalId: string): Promise<boolean> {
    const result = await this.database.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM role_grants
         WHERE principal_id = $1
           AND status = 'active'
           AND lower(role_key) = 'guest'
       ) AS present`,
      [principalId],
    );
    return result.rows[0]?.present ?? false;
  }

  async createConnection(
    input: CreateDataConnectionValue,
    actorPrincipalId: string,
  ): Promise<DataConnection> {
    const result = await this.database.query<ConnectionRow>(
      `INSERT INTO data_connections (
         id, workspace_id, project_id, name, provider, status, revision,
         allowed_runtime_profile_ids, max_rows, timeout_ms, data_cutoff_at,
         created_by_principal_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'fixture', 'active', 1,
         $5::jsonb, $6, $7, $8, $9, NOW(), NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.workspaceId,
        input.projectId,
        input.name,
        JSON.stringify(input.allowedRuntimeProfileIds),
        input.maxRows,
        input.timeoutMs,
        input.dataCutoffAt ?? null,
        actorPrincipalId,
      ],
    );
    return connectionFromRow(result.rows[0]!);
  }

  async listConnections(
    projectId: string,
    workspaceId?: string,
  ): Promise<DataConnection[]> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT *
       FROM data_connections
       WHERE project_id = $1
         AND status = 'active'
         AND ($2::text IS NULL OR workspace_id = $2)
       ORDER BY name, id`,
      [projectId, workspaceId ?? null],
    );
    return result.rows.map(connectionFromRow);
  }

  async createDataset(
    input: CreateDatasetValue,
    actorPrincipalId: string,
  ): Promise<Dataset> {
    const connection = await selectConnection(this.database, input.connectionId);
    if (connection === undefined) {
      throw new DataFabricRepositoryError(
        "data_connection_not_found",
        "Data connection not found",
        404,
      );
    }
    const result = await this.database.query<DatasetRow>(
      `INSERT INTO datasets (
         id, connection_id, workspace_id, project_id, dataset_key, name,
         description, status, revision, max_rows, timeout_ms,
         created_by_principal_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'active', 1, $8, $9, $10,
         NOW(), NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        connection.id,
        connection.workspace_id,
        connection.project_id,
        input.key,
        input.name,
        input.description,
        input.maxRows,
        input.timeoutMs,
        actorPrincipalId,
      ],
    );
    return datasetFromRow(result.rows[0]!);
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    const result = await this.database.query<DatasetRow>(
      `SELECT *
       FROM datasets
       WHERE project_id = $1
         AND status = 'active'
       ORDER BY name, id`,
      [projectId],
    );
    return result.rows.map(datasetFromRow);
  }

  async getDataset(datasetId: string): Promise<Dataset | undefined> {
    const row = await selectDataset(this.database, datasetId);
    return row === undefined ? undefined : datasetFromRow(row);
  }

  async createColumn(
    datasetId: string,
    input: CreateDatasetColumnValue,
  ): Promise<DatasetColumn> {
    const dataset = await selectDataset(this.database, datasetId);
    if (dataset === undefined) {
      throw new DataFabricRepositoryError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    const result = await this.database.query<ColumnRow>(
      `INSERT INTO dataset_columns (
         id, dataset_id, name, data_type, position, sensitive, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [
        randomUUID(),
        datasetId,
        input.name,
        input.dataType,
        input.position,
        input.sensitive ?? false,
      ],
    );
    return columnFromRow(result.rows[0]!);
  }

  async listColumns(datasetId: string): Promise<DatasetColumn[]> {
    const result = await this.database.query<ColumnRow>(
      `SELECT *
       FROM dataset_columns
       WHERE dataset_id = $1
       ORDER BY position, name`,
      [datasetId],
    );
    return result.rows.map(columnFromRow);
  }

  async createMetric(
    datasetId: string,
    input: CreateSemanticMetricValue,
    actorPrincipalId: string,
    digest: string,
  ): Promise<{ metric: SemanticMetric; version: SemanticMetricVersion }> {
    const dataset = await selectDataset(this.database, datasetId);
    if (dataset === undefined) {
      throw new DataFabricRepositoryError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    return withTransaction(this.database, async (client) => {
      const metricId = randomUUID();
      const version: SemanticMetricVersionContentValue = input.content;
      const metric = await client.query<MetricRow>(
        `INSERT INTO semantic_metrics (
           id, dataset_id, metric_key, title, current_version, status,
           revision, created_by_principal_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 1, 'active', 1, $5, NOW(), NOW())
         RETURNING *`,
        [metricId, datasetId, input.key, input.title, actorPrincipalId],
      );
      const savedVersion = await client.query<MetricVersionRow>(
        `INSERT INTO semantic_metric_versions (
           id, metric_id, version, aggregation, column_name, description,
           format, digest, created_by_principal_id, created_at
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [
          randomUUID(),
          metricId,
          version.aggregation,
          version.column,
          version.description,
          version.format,
          digest,
          actorPrincipalId,
        ],
      );
      return {
        metric: metricFromRow(metric.rows[0]!),
        version: metricVersionFromRow(savedVersion.rows[0]!),
      };
    });
  }

  async createMetricVersion(
    metricId: string,
    input: CreateSemanticMetricVersionValue,
    actorPrincipalId: string,
    digest: string,
  ): Promise<{ metric: SemanticMetric; version: SemanticMetricVersion }> {
    return withTransaction(this.database, async (client) => {
      const current = await client.query<MetricRow>(
        "SELECT * FROM semantic_metrics WHERE id = $1 FOR UPDATE",
        [metricId],
      );
      const metric = current.rows[0];
      if (metric === undefined) {
        throw new DataFabricRepositoryError(
          "data_metric_not_found",
          "Semantic metric not found",
          404,
        );
      }
      if (metric.current_version !== input.expectedCurrentVersion) {
        throw new DataFabricRepositoryError(
          "data_metric_version_conflict",
          "Semantic metric version changed",
          409,
        );
      }
      const nextVersion = metric.current_version + 1;
      const savedVersion = await client.query<MetricVersionRow>(
        `INSERT INTO semantic_metric_versions (
           id, metric_id, version, aggregation, column_name, description,
           format, digest, created_by_principal_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING *`,
        [
          randomUUID(),
          metricId,
          nextVersion,
          input.content.aggregation,
          input.content.column,
          input.content.description,
          input.content.format,
          digest,
          actorPrincipalId,
        ],
      );
      const updated = await client.query<MetricRow>(
        `UPDATE semantic_metrics
         SET current_version = $2, revision = revision + 1, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [metricId, nextVersion],
      );
      return {
        metric: metricFromRow(updated.rows[0]!),
        version: metricVersionFromRow(savedVersion.rows[0]!),
      };
    });
  }

  async listMetrics(
    datasetId: string,
  ): Promise<
    Array<{
      readonly metric: SemanticMetric;
      readonly version: SemanticMetricVersion;
    }>
  > {
    return listCurrentMetrics(this.database, datasetId);
  }

  async getMetricDatasetId(metricId: string): Promise<string | undefined> {
    const result = await this.database.query<{ dataset_id: string }>(
      "SELECT dataset_id FROM semantic_metrics WHERE id = $1",
      [metricId],
    );
    return result.rows[0]?.dataset_id;
  }

  async createPolicy(
    datasetId: string,
    input: CreateDataPolicyValue,
    actorPrincipalId: string,
    digest: string,
  ): Promise<DataPolicyBundle> {
    const dataset = await selectDataset(this.database, datasetId);
    if (dataset === undefined) {
      throw new DataFabricRepositoryError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    if (
      (input.scopeType === "project" && input.scopeId !== dataset.project_id) ||
      (input.scopeType === "workspace" &&
        input.scopeId !== dataset.workspace_id)
    ) {
      throw new DataFabricRepositoryError(
        "data_policy_scope_mismatch",
        "Data policy scope must match the dataset scope",
        400,
      );
    }
    return withTransaction(this.database, async (client) => {
      const policyId = randomUUID();
      const policyResult = await client.query<PolicyRow>(
        `INSERT INTO data_policies (
           id, dataset_id, scope_type, scope_id, current_version, status,
           revision, created_by_principal_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 1, 'active', 1, $5, NOW(), NOW())
         RETURNING *`,
        [
          policyId,
          datasetId,
          input.scopeType,
          input.scopeId,
          actorPrincipalId,
        ],
      );
      const version = input.content;
      const versionResult = await client.query<PolicyVersionRow>(
        `INSERT INTO data_policy_versions (
           id, policy_id, version, row_filters, allowed_columns,
           denied_columns, max_rows, timeout_ms, data_cutoff_at, digest,
           created_by_principal_id, created_at
         ) VALUES (
           $1, $2, 1, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9,
           $10, NOW()
         )
         RETURNING *`,
        [
          randomUUID(),
          policyId,
          JSON.stringify(version.rowFilters),
          JSON.stringify(version.allowedColumns),
          JSON.stringify(version.deniedColumns),
          version.maxRows,
          version.timeoutMs,
          version.dataCutoffAt ?? null,
          digest,
          actorPrincipalId,
        ],
      );
      return {
        policy: policyFromRow(policyResult.rows[0]!),
        version: policyVersionFromRow(versionResult.rows[0]!),
      };
    });
  }

  async createPolicyVersion(
    policyId: string,
    input: CreateDataPolicyVersionValue,
    actorPrincipalId: string,
    digest: string,
  ): Promise<DataPolicyBundle> {
    return withTransaction(this.database, async (client) => {
      const current = await client.query<PolicyRow>(
        "SELECT * FROM data_policies WHERE id = $1 FOR UPDATE",
        [policyId],
      );
      const policy = current.rows[0];
      if (policy === undefined) {
        throw new DataFabricRepositoryError(
          "data_policy_not_found",
          "Data policy not found",
          404,
        );
      }
      if (policy.current_version !== input.expectedCurrentVersion) {
        throw new DataFabricRepositoryError(
          "data_policy_version_conflict",
          "Data policy version changed",
          409,
        );
      }
      const nextVersion = policy.current_version + 1;
      const version: DataPolicyVersionContentValue = input.content;
      const savedVersion = await client.query<PolicyVersionRow>(
        `INSERT INTO data_policy_versions (
           id, policy_id, version, row_filters, allowed_columns,
           denied_columns, max_rows, timeout_ms, data_cutoff_at, digest,
           created_by_principal_id, created_at
         ) VALUES (
           $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10,
           $11, NOW()
         )
         RETURNING *`,
        [
          randomUUID(),
          policyId,
          nextVersion,
          JSON.stringify(version.rowFilters),
          JSON.stringify(version.allowedColumns),
          JSON.stringify(version.deniedColumns),
          version.maxRows,
          version.timeoutMs,
          version.dataCutoffAt ?? null,
          digest,
          actorPrincipalId,
        ],
      );
      const updated = await client.query<PolicyRow>(
        `UPDATE data_policies
         SET current_version = $2, revision = revision + 1, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [policyId, nextVersion],
      );
      return {
        policy: policyFromRow(updated.rows[0]!),
        version: policyVersionFromRow(savedVersion.rows[0]!),
      };
    });
  }

  async listPolicies(datasetId: string): Promise<DataPolicyBundle[]> {
    return listCurrentPolicies(this.database, datasetId);
  }

  async getDatasetQueryBundle(
    datasetId: string,
  ): Promise<DatasetQueryBundle | undefined> {
    const datasetRow = await selectDataset(this.database, datasetId);
    if (datasetRow === undefined) return undefined;
    const [connection, columns, metrics, policies] = await Promise.all([
      selectConnection(this.database, datasetRow.connection_id),
      this.listColumns(datasetId),
      listCurrentMetrics(this.database, datasetId),
      listCurrentPolicies(this.database, datasetId),
    ]);
    if (connection === undefined) return undefined;
    return {
      connection: connectionFromRow(connection),
      dataset: datasetFromRow(datasetRow),
      columns,
      metrics,
      policies,
    };
  }

  async readDatasetRows(
    datasetId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query<{ row_data: Record<string, unknown> }>(
      `SELECT row_data
       FROM dataset_rows
       WHERE dataset_id = $1
       ORDER BY row_key`,
      [datasetId],
    );
    return result.rows.map((row) => row.row_data);
  }

  async getRunContext(runId: string): Promise<DataFabricRunContext | undefined> {
    const result = await this.database.query<RunContextRow>(
      `SELECT
         run.id,
         run.project_id,
         run.agent_id,
         COALESCE(
           run.agent_principal_id,
           run.execution_envelope_snapshot ->> 'agentPrincipalId'
         ) AS agent_principal_id,
         run.execution_envelope_snapshot #>> '{runtime,id}'
           AS runtime_profile_id,
         run.context_pack_id,
         snapshot.snapshot_digest AS skill_snapshot_digest,
         run.initiated_by_principal_id
       FROM runs AS run
       LEFT JOIN run_skill_snapshots AS snapshot
         ON snapshot.run_id = run.id
       WHERE run.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.agent_principal_id === null ||
      row.runtime_profile_id === null
    ) {
      return undefined;
    }
    return {
      runId: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      agentPrincipalId: row.agent_principal_id,
      runtimeProfileId: row.runtime_profile_id,
      contextPackId: row.context_pack_id,
      skillSnapshotDigest: row.skill_snapshot_digest,
      initiatedByPrincipalId: row.initiated_by_principal_id,
    };
  }

  async isAgentPrincipalActive(principalId: string): Promise<boolean> {
    const result = await this.database.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM principals
         WHERE id = $1
           AND kind = 'ai'
           AND status = 'active'
       ) AS active`,
      [principalId],
    );
    return result.rows[0]?.active ?? false;
  }

  async isAgentActive(agentId: string): Promise<boolean> {
    const result = await this.database.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM agents
         WHERE id = $1 AND status = 'active'
       ) AS active`,
      [agentId],
    );
    return result.rows[0]?.active ?? false;
  }

  async createConversation(input: {
    readonly run: DataFabricRunContext;
    readonly requesterPrincipalId: string;
    readonly title: string;
  }): Promise<{ conversation: DataAgentConversation; reused: boolean }> {
    const inserted = await this.database.query<ConversationRow>(
      `INSERT INTO data_agent_conversations (
         id, project_id, run_id, context_pack_id, skill_snapshot_digest,
         runtime_profile_id, requester_principal_id, agent_id,
         agent_principal_id, title, status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NOW(), NOW()
       )
       ON CONFLICT (run_id) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        input.run.projectId,
        input.run.runId,
        input.run.contextPackId,
        input.run.skillSnapshotDigest,
        input.run.runtimeProfileId,
        input.requesterPrincipalId,
        input.run.agentId,
        input.run.agentPrincipalId,
        input.title,
      ],
    );
    if (inserted.rows[0] !== undefined) {
      return {
        conversation: conversationFromRow(inserted.rows[0]),
        reused: false,
      };
    }
    const existing = await this.database.query<ConversationRow>(
      `SELECT *
       FROM data_agent_conversations
       WHERE run_id = $1
         AND requester_principal_id = $2`,
      [input.run.runId, input.requesterPrincipalId],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new DataFabricRepositoryError(
        "data_agent_conversation_conflict",
        "Run already belongs to a different Data Agent requester",
        409,
      );
    }
    return { conversation: conversationFromRow(row), reused: true };
  }

  async getConversation(
    conversationId: string,
  ): Promise<DataAgentConversation | undefined> {
    const result = await this.database.query<ConversationRow>(
      "SELECT * FROM data_agent_conversations WHERE id = $1",
      [conversationId],
    );
    return result.rows[0] === undefined
      ? undefined
      : conversationFromRow(result.rows[0]);
  }

  async createMessage(
    conversationId: string,
    role: "user" | "agent" | "system",
    input: CreateDataAgentMessageValue,
  ): Promise<DataAgentMessage> {
    return withTransaction(this.database, async (client) => {
      const conversation = await client.query<{ id: string }>(
        `SELECT id
         FROM data_agent_conversations
         WHERE id = $1 AND status = 'active'
         FOR UPDATE`,
        [conversationId],
      );
      if (conversation.rows[0] === undefined) {
        throw new DataFabricRepositoryError(
          "data_agent_conversation_not_found",
          "Data Agent conversation not found",
          404,
        );
      }
      const sequence = await client.query<{ next_sequence: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM data_agent_messages
         WHERE conversation_id = $1`,
        [conversationId],
      );
      const inserted = await client.query<MessageRow>(
        `INSERT INTO data_agent_messages (
           id, conversation_id, sequence, role, content, query_run_id,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [
          randomUUID(),
          conversationId,
          Number(sequence.rows[0]?.next_sequence ?? "1"),
          role,
          input.content,
          input.queryRunId ?? null,
        ],
      );
      await client.query(
        `UPDATE data_agent_conversations
         SET updated_at = NOW()
         WHERE id = $1`,
        [conversationId],
      );
      return messageFromRow(inserted.rows[0]!);
    });
  }

  async listMessages(conversationId: string): Promise<DataAgentMessage[]> {
    const result = await this.database.query<MessageRow>(
      `SELECT *
       FROM data_agent_messages
       WHERE conversation_id = $1
       ORDER BY sequence`,
      [conversationId],
    );
    return result.rows.map(messageFromRow);
  }

  async createContextRef(input: {
    readonly conversationId: string;
    readonly messageId?: string | null;
    readonly kind: DataAgentContextRefKind;
    readonly refId: string;
    readonly version?: number | null;
    readonly digest?: string | null;
    readonly cutoffAt?: string | null;
  }): Promise<DataAgentContextRef> {
    const result = await this.database.query<ContextRefRow>(
      `INSERT INTO data_agent_context_refs (
         id, conversation_id, message_id, kind, ref_id, version, digest,
         cutoff_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [
        randomUUID(),
        input.conversationId,
        input.messageId ?? null,
        input.kind,
        input.refId,
        input.version ?? null,
        input.digest ?? null,
        input.cutoffAt ?? null,
      ],
    );
    return contextRefFromRow(result.rows[0]!);
  }

  async listContextRefs(
    conversationId: string,
  ): Promise<DataAgentContextRef[]> {
    const result = await this.database.query<ContextRefRow>(
      `SELECT *
       FROM data_agent_context_refs
       WHERE conversation_id = $1
       ORDER BY created_at, id`,
      [conversationId],
    );
    return result.rows.map(contextRefFromRow);
  }

  async createQueryRun(
    input: CreateQueryRunRecordInput,
  ): Promise<QueryRun> {
    const result = await this.database.query<QueryRunRow>(
      `INSERT INTO query_runs (
         id, conversation_id, project_id, workspace_id, run_id,
         context_pack_id, skill_snapshot_digest, connection_id,
         connection_version, dataset_id, dataset_version, metric_id,
         metric_version, runtime_profile_id, mode, query_spec,
         requester_principal_id, agent_principal_id, row_filters,
         denied_columns, allowed_columns, max_rows, timeout_ms,
         data_cutoff_at, permission_summary, policy_snapshot, status,
         started_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb,
         $22, $23, $24, $25::jsonb, $26::jsonb, 'running', NOW(), NOW(), NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.conversation.id,
        input.conversation.projectId,
        input.dataset.workspaceId,
        input.conversation.runId,
        input.conversation.contextPackId,
        input.conversation.skillSnapshotDigest,
        input.connection.id,
        input.connection.revision,
        input.dataset.id,
        input.dataset.revision,
        input.metric?.id ?? null,
        input.metricVersion?.version ?? null,
        input.conversation.runtimeProfileId,
        input.mode,
        JSON.stringify(input.querySpec),
        input.conversation.requesterPrincipalId,
        input.conversation.agentPrincipalId,
        JSON.stringify(input.rowFilters),
        JSON.stringify(input.deniedColumns),
        JSON.stringify(input.allowedColumns),
        input.maxRows,
        input.timeoutMs,
        input.dataCutoffAt,
        JSON.stringify(input.permissionSummary),
        JSON.stringify(
          input.policies.map((bundle) => ({
            policyId: bundle.policy.id,
            versionId: bundle.version.id,
            version: bundle.version.version,
            digest: bundle.version.digest,
          })),
        ),
      ],
    );
    return queryRunFromRow(result.rows[0]!);
  }

  async completeQueryRun(input: {
    readonly queryRunId: string;
    readonly scanCount: number;
    readonly rowCount: number;
    readonly resultDigest: string;
    readonly columns: string[];
    readonly rows: Array<Record<string, unknown>>;
  }): Promise<QueryResult | undefined> {
    return withTransaction(this.database, async (client) => {
      const updated = await client.query<QueryRunRow>(
        `UPDATE query_runs
         SET status = 'completed', scan_count = $2, row_count = $3,
             result_digest = $4, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'running'
         RETURNING *`,
        [
          input.queryRunId,
          input.scanCount,
          input.rowCount,
          input.resultDigest,
        ],
      );
      if (updated.rows[0] === undefined) return undefined;
      const result = await client.query<FabricQueryResultRow>(
        `INSERT INTO query_results (
           query_run_id, columns, rows, digest, created_at
         ) VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW())
         RETURNING *`,
        [
          input.queryRunId,
          JSON.stringify(input.columns),
          JSON.stringify(input.rows),
          input.resultDigest,
        ],
      );
      return queryResultFromRow(result.rows[0]!);
    });
  }

  async failQueryRun(input: {
    readonly queryRunId: string;
    readonly status: "failed" | "cancelled" | "timeout";
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly scanCount?: number | null;
  }): Promise<QueryRun | undefined> {
    const result = await this.database.query<QueryRunRow>(
      `UPDATE query_runs
       SET status = $2, scan_count = $3, row_count = NULL,
           result_digest = NULL, error_code = $4, error_message = $5,
           completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [
        input.queryRunId,
        input.status,
        input.scanCount ?? null,
        input.errorCode,
        input.errorMessage,
      ],
    );
    return result.rows[0] === undefined
      ? undefined
      : queryRunFromRow(result.rows[0]);
  }

  async cancelQueryRun(
    queryRunId: string,
    requesterPrincipalId: string,
  ): Promise<QueryRun | undefined> {
    const result = await this.database.query<QueryRunRow>(
      `UPDATE query_runs
       SET status = 'cancelled', error_code = 'data_query_cancelled',
           error_message = 'QueryRun was cancelled',
           completed_at = NOW(), updated_at = NOW()
       WHERE id = $1
         AND requester_principal_id = $2
         AND status IN ('queued', 'running')
       RETURNING *`,
      [queryRunId, requesterPrincipalId],
    );
    return result.rows[0] === undefined
      ? undefined
      : queryRunFromRow(result.rows[0]);
  }

  async getQueryRun(queryRunId: string): Promise<QueryRun | undefined> {
    const result = await this.database.query<QueryRunRow>(
      "SELECT * FROM query_runs WHERE id = $1",
      [queryRunId],
    );
    return result.rows[0] === undefined
      ? undefined
      : queryRunFromRow(result.rows[0]);
  }

  async getQueryResult(
    queryRunId: string,
  ): Promise<QueryResult | undefined> {
    const result = await this.database.query<FabricQueryResultRow>(
      "SELECT * FROM query_results WHERE query_run_id = $1",
      [queryRunId],
    );
    return result.rows[0] === undefined
      ? undefined
      : queryResultFromRow(result.rows[0]);
  }

  async listQueryRuns(conversationId: string): Promise<QueryRun[]> {
    const result = await this.database.query<QueryRunRow>(
      `SELECT *
       FROM query_runs
       WHERE conversation_id = $1
       ORDER BY created_at, id`,
      [conversationId],
    );
    return result.rows.map(queryRunFromRow);
  }

  async getProjectReport(
    reportId: string,
  ): Promise<ProjectReportReference | undefined> {
    const result = await this.database.query<{
      id: string;
      project_id: string;
      version: number;
      content_hash: string;
      source_cutoff_at: Date;
    }>(
      `SELECT id, project_id, version, content_hash, source_cutoff_at
       FROM project_reports
       WHERE id = $1`,
      [reportId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          projectId: row.project_id,
          version: row.version,
          digest: row.content_hash,
          cutoffAt: row.source_cutoff_at,
        };
  }

  async createAnswer(input: {
    readonly conversation: DataAgentConversation;
    readonly content: string;
    readonly digest: string;
    readonly queryRuns: QueryRun[];
    readonly projectReport: ProjectReportReference | null;
    readonly contextRefs: Array<{
      readonly kind: DataAgentContextRefKind;
      readonly refId: string;
      readonly version?: number | null;
      readonly digest?: string | null;
      readonly cutoffAt?: string | null;
    }>;
  }): Promise<DataAgentAnswer> {
    return withTransaction(this.database, async (client) => {
      const conversation = await client.query<{ id: string }>(
        `SELECT id
         FROM data_agent_conversations
         WHERE id = $1 AND status = 'active'
         FOR UPDATE`,
        [input.conversation.id],
      );
      if (conversation.rows[0] === undefined) {
        throw new DataFabricRepositoryError(
          "data_agent_conversation_not_found",
          "Data Agent conversation not found",
          404,
        );
      }
      const sequence = await client.query<{ next_sequence: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM data_agent_messages
         WHERE conversation_id = $1`,
        [input.conversation.id],
      );
      const message = await client.query<MessageRow>(
        `INSERT INTO data_agent_messages (
           id, conversation_id, sequence, role, content, query_run_id,
           created_at
         ) VALUES ($1, $2, $3, 'agent', $4, $5, NOW())
         RETURNING *`,
        [
          randomUUID(),
          input.conversation.id,
          Number(sequence.rows[0]?.next_sequence ?? "1"),
          input.content,
          input.queryRuns[0]?.id ?? null,
        ],
      );
      const contextRefIds: string[] = [];
      for (const ref of input.contextRefs) {
        const inserted = await client.query<ContextRefRow>(
          `INSERT INTO data_agent_context_refs (
             id, conversation_id, message_id, kind, ref_id, version, digest,
             cutoff_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           RETURNING *`,
          [
            randomUUID(),
            input.conversation.id,
            message.rows[0]!.id,
            ref.kind,
            ref.refId,
            ref.version ?? null,
            ref.digest ?? null,
            ref.cutoffAt ?? null,
          ],
        );
        contextRefIds.push(inserted.rows[0]!.id);
      }
      const answerId = randomUUID();
      const answer = await client.query<AnswerRow>(
        `INSERT INTO data_agent_answers (
           id, conversation_id, message_id, project_id, run_id,
           context_pack_id, skill_snapshot_digest, requester_principal_id,
           agent_principal_id, project_report_id, content, digest, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
         )
         RETURNING *`,
        [
          answerId,
          input.conversation.id,
          message.rows[0]!.id,
          input.conversation.projectId,
          input.conversation.runId,
          input.conversation.contextPackId,
          input.conversation.skillSnapshotDigest,
          input.conversation.requesterPrincipalId,
          input.conversation.agentPrincipalId,
          input.projectReport?.id ?? null,
          input.content,
          input.digest,
        ],
      );
      for (const [position, queryRun] of input.queryRuns.entries()) {
        await client.query(
          `INSERT INTO data_agent_answer_query_runs (
             answer_id, query_run_id, position
           ) VALUES ($1, $2, $3)`,
          [answerId, queryRun.id, position],
        );
      }
      for (const contextRefId of contextRefIds) {
        await client.query(
          `INSERT INTO data_agent_answer_context_refs (
             answer_id, context_ref_id
           ) VALUES ($1, $2)`,
          [answerId, contextRefId],
        );
      }
      await client.query(
        `UPDATE data_agent_conversations
         SET updated_at = NOW()
         WHERE id = $1`,
        [input.conversation.id],
      );
      return {
        id: answer.rows[0]!.id,
        conversationId: answer.rows[0]!.conversation_id,
        messageId: answer.rows[0]!.message_id,
        projectId: answer.rows[0]!.project_id,
        runId: answer.rows[0]!.run_id,
        contextPackId: answer.rows[0]!.context_pack_id,
        skillSnapshotDigest: answer.rows[0]!.skill_snapshot_digest,
        requesterPrincipalId: answer.rows[0]!.requester_principal_id,
        agentPrincipalId: answer.rows[0]!.agent_principal_id,
        queryRunIds: input.queryRuns.map((run) => run.id),
        contextRefIds,
        projectReportId: answer.rows[0]!.project_report_id,
        content: answer.rows[0]!.content,
        digest: answer.rows[0]!.digest,
        createdAt: answer.rows[0]!.created_at.toISOString(),
      };
    });
  }

  async listAnswers(conversationId: string): Promise<DataAgentAnswer[]> {
    const answers = await this.database.query<AnswerRow>(
      `SELECT *
       FROM data_agent_answers
       WHERE conversation_id = $1
       ORDER BY created_at, id`,
      [conversationId],
    );
    const items: DataAgentAnswer[] = [];
    for (const row of answers.rows) {
      const [queryRuns, contextRefs] = await Promise.all([
        this.database.query<{ query_run_id: string }>(
          `SELECT query_run_id
           FROM data_agent_answer_query_runs
           WHERE answer_id = $1
           ORDER BY position`,
          [row.id],
        ),
        this.database.query<{ context_ref_id: string }>(
          `SELECT context_ref_id
           FROM data_agent_answer_context_refs
           WHERE answer_id = $1
           ORDER BY context_ref_id`,
          [row.id],
        ),
      ]);
      items.push({
        id: row.id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        projectId: row.project_id,
        runId: row.run_id,
        contextPackId: row.context_pack_id,
        skillSnapshotDigest: row.skill_snapshot_digest,
        requesterPrincipalId: row.requester_principal_id,
        agentPrincipalId: row.agent_principal_id,
        queryRunIds: queryRuns.rows.map((item) => item.query_run_id),
        contextRefIds: contextRefs.rows.map((item) => item.context_ref_id),
        projectReportId: row.project_report_id,
        content: row.content,
        digest: row.digest,
        createdAt: row.created_at.toISOString(),
      });
    }
    return items;
  }
}
