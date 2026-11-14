import { createHash } from "node:crypto";
import type {
  CreateDataAgentAnswerValue,
  CreateDataAgentMessageValue,
  CreateDataConnectionValue,
  CreateDataPolicyValue,
  CreateDataPolicyVersionValue,
  CreateDatasetColumnValue,
  CreateDatasetValue,
  CreateSemanticMetricValue,
  CreateSemanticMetricVersionValue,
  DataAgentAnswer,
  DataAgentContextRefKind,
  DataAgentConversation,
  DataAgentConversationDetail,
  DataConnection,
  DataRowFilter,
  Dataset,
  DatasetColumn,
  ExecuteDataQueryValue,
  QueryPermissionSummary,
  QueryResult,
  QueryRun,
  SemanticMetric,
  SemanticMetricVersion,
} from "@pluginmax/contracts";
import type {
  DataFabricRepository,
  DataFabricRunContext,
  DataPolicyBundle,
  DatasetQueryBundle,
} from "@pluginmax/database";
import type { AuthorizationRepository } from "@pluginmax/database";

const MAX_HARD_ROWS = 1_000;
const MAX_HARD_TIMEOUT_MS = 60_000;

export interface DataFabricActor {
  readonly principalId: string;
  readonly authSource: "bearer" | "local-development";
  readonly platformAdministrator: boolean;
}

export interface DataFabricQueryAdapterInput {
  readonly dataset: Dataset;
  readonly columns: DatasetColumn[];
  readonly signal: AbortSignal;
}

export interface DataFabricQueryAdapter {
  scan(
    input: DataFabricQueryAdapterInput,
  ): Promise<Array<Record<string, unknown>>>;
}

export class FixtureDataFabricQueryAdapter implements DataFabricQueryAdapter {
  constructor(private readonly repository: DataFabricRepository) {}

  async scan(
    input: DataFabricQueryAdapterInput,
  ): Promise<Array<Record<string, unknown>>> {
    if (input.signal.aborted) {
      throw new DataFabricApplicationError(
        "data_query_cancelled",
        "QueryRun was cancelled",
        409,
      );
    }
    return this.repository.readDatasetRows(input.dataset.id);
  }
}

export class DataFabricApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DataFabricApplicationError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function scalarEquals(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return String(left) === String(right);
  }
  return left === right || String(left) === String(right);
}

function compareScalar(left: unknown, right: unknown): number | undefined {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      return leftTime - rightTime;
    }
    return left.localeCompare(right);
  }
  return undefined;
}

function matchesRowFilter(
  row: Record<string, unknown>,
  filter: DataRowFilter,
): boolean {
  const current = row[filter.column];
  if (filter.operator === "eq") {
    return scalarEquals(current, filter.values[0]);
  }
  if (filter.operator === "neq") {
    return !scalarEquals(current, filter.values[0]);
  }
  if (filter.operator === "in") {
    return filter.values.some((value) => scalarEquals(current, value));
  }
  const comparison = compareScalar(current, filter.values[0]);
  if (comparison === undefined) return false;
  return filter.operator === "gte" ? comparison >= 0 : comparison <= 0;
}

function earliestCutoff(
  candidates: Array<string | null | undefined>,
): string | null {
  const values = candidates
    .filter((value): value is string => value !== null && value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return values[0] ?? null;
}

function effectiveAllowedColumns(
  bundle: DatasetQueryBundle,
  policies: DataPolicyBundle[],
): { readonly allowed: string[]; readonly denied: string[] } {
  const allColumns = bundle.columns.map((column) => column.name);
  let allowed = new Set(allColumns);
  const denied = new Set<string>();
  for (const policy of policies) {
    for (const column of policy.version.deniedColumns) denied.add(column);
    if (policy.version.allowedColumns.length > 0) {
      const explicit = new Set(policy.version.allowedColumns);
      allowed = new Set([...allowed].filter((column) => explicit.has(column)));
    }
  }
  for (const column of denied) allowed.delete(column);
  return {
    allowed: allColumns.filter((column) => allowed.has(column)),
    denied: [...denied].sort(),
  };
}

export interface DataQueryExecutionResult {
  readonly queryRun: QueryRun;
  readonly result: QueryResult;
}

export class DataFabricApplication {
  private readonly activeQueries = new Map<string, AbortController>();

  constructor(
    private readonly repository: DataFabricRepository,
    private readonly authorization: AuthorizationRepository,
    private readonly adapter: DataFabricQueryAdapter = new FixtureDataFabricQueryAdapter(
      repository,
    ),
  ) {}

  async createConnection(
    input: CreateDataConnectionValue,
    actor: DataFabricActor,
  ): Promise<DataConnection> {
    this.assertAdministrator(actor);
    const connection = await this.repository.createConnection(
      input,
      actor.principalId,
    );
    await this.audit(actor, "data.connection.created", connection.id, {
      workspaceId: connection.workspaceId,
      projectId: connection.projectId,
      allowedRuntimeProfileIds: connection.allowedRuntimeProfileIds,
    });
    return connection;
  }

  async listConnections(
    projectId: string,
    actor: DataFabricActor,
    workspaceId?: string,
  ): Promise<DataConnection[]> {
    const connections = await this.repository.listConnections(
      projectId,
      workspaceId,
    );
    if (actor.platformAdministrator) return connections;
    if (await this.repository.hasGuestRole(actor.principalId)) return [];
    if (!(await this.hasProjectRead(actor, projectId))) return [];
    const visible: DataConnection[] = [];
    for (const connection of connections) {
      const workspace = await this.authorization.authorizeWorkspace({
        principalId: actor.principalId,
        authSource: actor.authSource,
        workspaceId: connection.workspaceId,
        permission: "read",
      });
      if (workspace.allowed) visible.push(connection);
    }
    return visible;
  }

  async createDataset(
    input: CreateDatasetValue,
    actor: DataFabricActor,
  ): Promise<Dataset> {
    this.assertAdministrator(actor);
    const dataset = await this.repository.createDataset(
      input,
      actor.principalId,
    );
    await this.audit(actor, "data.dataset.created", dataset.id, {
      connectionId: dataset.connectionId,
      workspaceId: dataset.workspaceId,
      projectId: dataset.projectId,
    });
    return dataset;
  }

  async listDatasets(
    projectId: string,
    actor: DataFabricActor,
  ): Promise<Dataset[]> {
    const datasets = await this.repository.listDatasets(projectId);
    if (actor.platformAdministrator) return datasets;
    const visible: Dataset[] = [];
    for (const dataset of datasets) {
      if (await this.canDiscoverDataset(dataset, actor)) visible.push(dataset);
    }
    return visible;
  }

  async getDataset(
    datasetId: string,
    actor: DataFabricActor,
  ): Promise<{
    dataset: Dataset;
    columns: DatasetColumn[];
    metrics: Array<{
      metric: SemanticMetric;
      version: SemanticMetricVersion;
    }>;
    policies: DataPolicyBundle[];
  }> {
    const bundle = await this.repository.getDatasetQueryBundle(datasetId);
    if (bundle === undefined) {
      throw new DataFabricApplicationError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    if (
      !actor.platformAdministrator &&
      !(await this.canDiscoverDataset(bundle.dataset, actor))
    ) {
      throw new DataFabricApplicationError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    return {
      dataset: bundle.dataset,
      columns: bundle.columns,
      metrics: bundle.metrics,
      policies: bundle.policies,
    };
  }

  async createColumn(
    datasetId: string,
    input: CreateDatasetColumnValue,
    actor: DataFabricActor,
  ): Promise<DatasetColumn> {
    this.assertAdministrator(actor);
    const column = await this.repository.createColumn(datasetId, input);
    await this.audit(actor, "data.column.created", column.id, {
      datasetId,
      name: column.name,
      dataType: column.dataType,
      sensitive: column.sensitive,
    });
    return column;
  }

  async createMetric(
    datasetId: string,
    input: CreateSemanticMetricValue,
    actor: DataFabricActor,
  ): Promise<{
    metric: SemanticMetric;
    version: SemanticMetricVersion;
  }> {
    this.assertAdministrator(actor);
    const columns = await this.repository.listColumns(datasetId);
    if (!columns.some((column) => column.name === input.content.column)) {
      throw new DataFabricApplicationError(
        "data_metric_column_not_found",
        "Semantic metric column is not part of the dataset",
        400,
      );
    }
    const metricDigest = digest({
      datasetId,
      key: input.key,
      title: input.title,
      content: input.content,
    });
    const saved = await this.repository.createMetric(
      datasetId,
      input,
      actor.principalId,
      metricDigest,
    );
    await this.audit(actor, "data.metric.created", saved.metric.id, {
      datasetId,
      key: saved.metric.key,
      version: saved.version.version,
      digest: saved.version.digest,
    });
    return saved;
  }

  async createMetricVersion(
    metricId: string,
    input: CreateSemanticMetricVersionValue,
    actor: DataFabricActor,
  ): Promise<{
    metric: SemanticMetric;
    version: SemanticMetricVersion;
  }> {
    this.assertAdministrator(actor);
    const metricDatasetId = await this.repository.getMetricDatasetId(metricId);
    if (metricDatasetId === undefined) {
      throw new DataFabricApplicationError(
        "data_metric_not_found",
        "Semantic metric not found",
        404,
      );
    }
    const columns = await this.repository.listColumns(metricDatasetId);
    if (!columns.some((column) => column.name === input.content.column)) {
      throw new DataFabricApplicationError(
        "data_metric_column_not_found",
        "Semantic metric column is not part of the dataset",
        400,
      );
    }
    const metricDigest = digest({
      metricId,
      expectedCurrentVersion: input.expectedCurrentVersion,
      content: input.content,
    });
    const saved = await this.repository.createMetricVersion(
      metricId,
      input,
      actor.principalId,
      metricDigest,
    );
    await this.audit(actor, "data.metric.version.created", metricId, {
      version: saved.version.version,
      digest: saved.version.digest,
    });
    return saved;
  }

  async createPolicy(
    datasetId: string,
    input: CreateDataPolicyValue,
    actor: DataFabricActor,
  ): Promise<DataPolicyBundle> {
    this.assertAdministrator(actor);
    await this.validatePolicyColumns(datasetId, input.content);
    const policyDigest = digest({
      datasetId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      content: input.content,
    });
    const saved = await this.repository.createPolicy(
      datasetId,
      input,
      actor.principalId,
      policyDigest,
    );
    await this.audit(actor, "data.policy.created", saved.policy.id, {
      datasetId,
      scopeType: saved.policy.scopeType,
      scopeId: saved.policy.scopeId,
      version: saved.version.version,
      digest: saved.version.digest,
    });
    return saved;
  }

  async createPolicyVersion(
    datasetId: string,
    policyId: string,
    input: CreateDataPolicyVersionValue,
    actor: DataFabricActor,
  ): Promise<DataPolicyBundle> {
    this.assertAdministrator(actor);
    await this.validatePolicyColumns(datasetId, input.content);
    const policyDigest = digest({
      datasetId,
      policyId,
      expectedCurrentVersion: input.expectedCurrentVersion,
      content: input.content,
    });
    const saved = await this.repository.createPolicyVersion(
      policyId,
      input,
      actor.principalId,
      policyDigest,
    );
    await this.audit(actor, "data.policy.version.created", policyId, {
      datasetId,
      version: saved.version.version,
      digest: saved.version.digest,
    });
    return saved;
  }

  async listPolicies(
    datasetId: string,
    actor: DataFabricActor,
  ): Promise<DataPolicyBundle[]> {
    const dataset = await this.repository.getDataset(datasetId);
    if (dataset === undefined) {
      throw new DataFabricApplicationError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    if (
      !actor.platformAdministrator &&
      !(await this.canDiscoverDataset(dataset, actor))
    ) {
      throw new DataFabricApplicationError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    return this.repository.listPolicies(datasetId);
  }

  async createConversation(
    runId: string,
    title: string,
    actor: DataFabricActor,
  ): Promise<{
    conversation: DataAgentConversation;
    reused: boolean;
  }> {
    await this.assertFeatureEnabled();
    await this.assertNotGuest(actor);
    const run = await this.repository.getRunContext(runId);
    if (run === undefined) {
      throw new DataFabricApplicationError(
        "data_agent_run_context_missing",
        "Run is missing Runtime Profile or Agent Principal context",
        409,
      );
    }
    if (!(await this.hasProjectRead(actor, run.projectId))) {
      throw new DataFabricApplicationError(
        "data_agent_access_denied",
        "Project read access is required",
        403,
      );
    }
    if (
      !actor.platformAdministrator &&
      run.initiatedByPrincipalId !== null &&
      run.initiatedByPrincipalId !== actor.principalId
    ) {
      throw new DataFabricApplicationError(
        "data_agent_access_denied",
        "Only the Run initiator can create its Data Agent conversation",
        403,
      );
    }
    if (
      !(await this.repository.isAgentActive(run.agentId)) ||
      !(await this.repository.isAgentPrincipalActive(run.agentPrincipalId))
    ) {
      throw new DataFabricApplicationError(
        "data_agent_principal_inactive",
        "Data Agent requires an active Agent and Agent Principal",
        403,
      );
    }
    const saved = await this.repository.createConversation({
      run,
      requesterPrincipalId: actor.principalId,
      title,
    });
    if (!saved.reused) {
      await this.createConversationRefs(saved.conversation, run);
      await this.audit(actor, "data.agent.conversation.created", saved.conversation.id, {
        runId,
        projectId: run.projectId,
        agentPrincipalId: run.agentPrincipalId,
      });
    }
    return saved;
  }

  async getConversation(
    conversationId: string,
    actor: DataFabricActor,
  ): Promise<DataAgentConversationDetail> {
    const conversation = await this.requireConversation(
      conversationId,
      actor,
      false,
    );
    const [messages, contextRefs, queryRuns, answers] = await Promise.all([
      this.repository.listMessages(conversationId),
      this.repository.listContextRefs(conversationId),
      this.repository.listQueryRuns(conversationId),
      this.repository.listAnswers(conversationId),
    ]);
    return { conversation, messages, contextRefs, queryRuns, answers };
  }

  async createUserMessage(
    conversationId: string,
    input: CreateDataAgentMessageValue,
    actor: DataFabricActor,
  ): Promise<DataAgentConversationDetail> {
    await this.assertFeatureEnabled();
    const conversation = await this.requireConversation(
      conversationId,
      actor,
      true,
    );
    if (input.queryRunId !== undefined) {
      const queryRun = await this.repository.getQueryRun(input.queryRunId);
      if (
        queryRun === undefined ||
        queryRun.conversationId !== conversation.id
      ) {
        throw new DataFabricApplicationError(
          "data_query_run_not_found",
          "QueryRun not found in this conversation",
          404,
        );
      }
    }
    const message = await this.repository.createMessage(
      conversation.id,
      "user",
      input,
    );
    if (input.queryRunId !== undefined) {
      await this.repository.createContextRef({
        conversationId: conversation.id,
        messageId: message.id,
        kind: "query-run",
        refId: input.queryRunId,
        digest:
          (await this.repository.getQueryRun(input.queryRunId))
            ?.resultDigest ?? null,
      });
    }
    await this.audit(actor, "data.agent.message.created", message.id, {
      conversationId: conversation.id,
      role: message.role,
      queryRunId: message.queryRunId,
    });
    return this.getConversation(conversation.id, actor);
  }

  async executeQuery(
    conversationId: string,
    input: ExecuteDataQueryValue,
    actor: DataFabricActor,
  ): Promise<DataQueryExecutionResult> {
    await this.assertFeatureEnabled();
    const conversation = await this.requireConversation(
      conversationId,
      actor,
      true,
    );
    const resolvedDatasetId =
      input.mode === "metric"
        ? await this.repository.getMetricDatasetId(input.metricId!)
        : input.datasetId!;
    if (resolvedDatasetId === undefined) {
      throw new DataFabricApplicationError(
        "data_metric_not_found",
        "Semantic metric not found",
        404,
      );
    }
    if (
      input.datasetId !== undefined &&
      input.datasetId !== resolvedDatasetId
    ) {
      throw new DataFabricApplicationError(
        "data_query_dataset_mismatch",
        "Metric does not belong to the requested dataset",
        400,
      );
    }
    const bundle = await this.repository.getDatasetQueryBundle(
      resolvedDatasetId,
    );
    if (bundle === undefined) {
      throw new DataFabricApplicationError(
        "data_dataset_not_found",
        "Dataset not found",
        404,
      );
    }
    const policyBundle = await this.authorizeDatasetQuery(
      conversation,
      bundle,
      actor,
      input,
    );
    const metricBundle =
      input.mode === "metric"
        ? bundle.metrics.find(
            (item) => item.metric.id === input.metricId,
          )
        : undefined;
    if (input.mode === "metric" && metricBundle === undefined) {
      throw new DataFabricApplicationError(
        "data_metric_not_found",
        "Semantic metric not found",
        404,
      );
    }
    const queryRun = await this.repository.createQueryRun({
      conversation,
      connection: bundle.connection,
      dataset: bundle.dataset,
      metric: metricBundle?.metric ?? null,
      metricVersion: metricBundle?.version ?? null,
      mode: input.mode,
      querySpec: {
        mode: input.mode,
        datasetId: bundle.dataset.id,
        metricId: metricBundle?.metric.id ?? null,
        columns: input.columns,
        maxRows: input.maxRows ?? null,
        timeoutMs: input.timeoutMs ?? null,
      },
      rowFilters: policyBundle.rowFilters,
      deniedColumns: policyBundle.allowed.denied,
      allowedColumns: policyBundle.allowed.allowed,
      maxRows: policyBundle.maxRows,
      timeoutMs: policyBundle.timeoutMs,
      dataCutoffAt: policyBundle.dataCutoffAt,
      permissionSummary: policyBundle.permissionSummary,
      policies: policyBundle.policies,
    });
    const requestedColumns =
      input.columns.length === 0
        ? policyBundle.allowed.allowed
        : input.columns;
    const forbidden = requestedColumns.filter(
      (column) =>
        !policyBundle.allowed.allowed.includes(column) ||
        policyBundle.allowed.denied.includes(column),
    );
    if (forbidden.length > 0) {
      await this.repository.failQueryRun({
        queryRunId: queryRun.id,
        status: "failed",
        errorCode: "data_column_denied",
        errorMessage: `Columns denied by policy: ${forbidden.join(", ")}`,
      });
      throw new DataFabricApplicationError(
        "data_column_denied",
        "One or more columns are denied by data policy",
        403,
        { queryRunId: queryRun.id, columns: forbidden },
      );
    }

    const controller = new AbortController();
    this.activeQueries.set(queryRun.id, controller);
    let scanCount: number | null = null;
    try {
      const scanned = await this.scanWithTimeout(
        {
          dataset: bundle.dataset,
          columns: bundle.columns,
          signal: controller.signal,
        },
        policyBundle.timeoutMs,
        controller,
      );
      scanCount = scanned.length;
      const filtered = scanned.filter((row) =>
        policyBundle.rowFilters.every((filter) =>
          matchesRowFilter(row, filter),
        ),
      );
      const projected =
        input.mode === "explain"
          ? []
          : input.mode === "metric"
            ? [
                {
                  [metricBundle!.metric.key]: aggregateMetric(
                    filtered,
                    metricBundle!.version,
                  ),
                },
              ]
            : filtered.map((row) =>
                Object.fromEntries(
                  requestedColumns.map((column) => [column, row[column]]),
                ),
              );
      const columns =
        input.mode === "metric"
          ? [metricBundle!.metric.key]
          : requestedColumns;
      const rows = projected.slice(0, policyBundle.maxRows);
      const resultDigest = digest({
        queryRunId: queryRun.id,
        querySpec: queryRun.querySpec,
        policySnapshot: queryRun.policySnapshot,
        dataCutoffAt: queryRun.dataCutoffAt,
        columns,
        rows,
      });
      const result = await this.repository.completeQueryRun({
        queryRunId: queryRun.id,
        scanCount,
        rowCount: rows.length,
        resultDigest,
        columns,
        rows,
      });
      if (result === undefined) {
        const current = await this.repository.getQueryRun(queryRun.id);
        if (current?.status === "cancelled") {
          throw new DataFabricApplicationError(
            "data_query_cancelled",
            "QueryRun was cancelled",
            409,
            { queryRunId: queryRun.id },
          );
        }
        throw new DataFabricApplicationError(
          "data_query_terminal",
          "QueryRun is no longer running",
          409,
          { queryRunId: queryRun.id },
        );
      }
      const completed = await this.repository.getQueryRun(queryRun.id);
      await this.audit(actor, "query.executed", queryRun.id, {
        conversationId,
        datasetId: bundle.dataset.id,
        metricId: metricBundle?.metric.id ?? null,
        status: completed?.status ?? "completed",
        scanCount,
        rowCount: rows.length,
        resultDigest,
      });
      return { queryRun: completed ?? queryRun, result };
    } catch (error) {
      const normalized = normalizeQueryFailure(error);
      const failed = await this.repository.failQueryRun({
        queryRunId: queryRun.id,
        status: normalized.status,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        scanCount,
      });
      const current = failed ?? (await this.repository.getQueryRun(queryRun.id));
      await this.audit(actor, "query.failed", queryRun.id, {
        conversationId,
        datasetId: bundle.dataset.id,
        status: current?.status ?? normalized.status,
        errorCode: normalized.code,
      });
      throw new DataFabricApplicationError(
        normalized.code,
        normalized.message,
        normalized.statusCode,
        { queryRunId: queryRun.id },
      );
    } finally {
      this.activeQueries.delete(queryRun.id);
    }
  }

  async createAnswer(
    conversationId: string,
    input: CreateDataAgentAnswerValue,
    actor: DataFabricActor,
  ): Promise<DataAgentAnswer> {
    await this.assertFeatureEnabled();
    const conversation = await this.requireConversation(
      conversationId,
      actor,
      true,
    );
    const queryRuns: QueryRun[] = [];
    for (const queryRunId of input.queryRunIds) {
      const queryRun = await this.repository.getQueryRun(queryRunId);
      if (
        queryRun === undefined ||
        queryRun.conversationId !== conversation.id
      ) {
        throw new DataFabricApplicationError(
          "data_query_run_not_found",
          "QueryRun not found in this conversation",
          404,
        );
      }
      if (queryRun.status !== "completed") {
        throw new DataFabricApplicationError(
          "data_query_run_incomplete",
          "Answers require completed QueryRuns",
          409,
          { queryRunId },
        );
      }
      if ((await this.repository.getQueryResult(queryRunId)) === undefined) {
        throw new DataFabricApplicationError(
          "data_query_result_missing",
          "Completed QueryRun has no QueryResult",
          409,
          { queryRunId },
        );
      }
      queryRuns.push(queryRun);
    }
    let projectReport:
      | {
          id: string;
          projectId: string;
          version: number;
          digest: string;
          cutoffAt: Date | null;
        }
      | null = null;
    if (input.projectReportId !== undefined) {
      const report = await this.repository.getProjectReport(
        input.projectReportId,
      );
      if (report === undefined || report.projectId !== conversation.projectId) {
        throw new DataFabricApplicationError(
          "project_report_not_found",
          "Project Report not found in this conversation project",
          404,
        );
      }
      projectReport = report;
    }
    const contextRefs: Array<{
      kind: DataAgentContextRefKind;
      refId: string;
      version?: number | null;
      digest?: string | null;
      cutoffAt?: string | null;
    }> = [
      { kind: "run", refId: conversation.runId },
      ...(conversation.contextPackId === null
        ? []
        : [
            {
              kind: "context-pack" as const,
              refId: conversation.contextPackId,
            },
          ]),
      ...(conversation.skillSnapshotDigest === null
        ? []
        : [
            {
              kind: "skill-snapshot" as const,
              refId: conversation.runId,
              digest: conversation.skillSnapshotDigest,
            },
          ]),
      ...queryRuns.map((queryRun) => ({
        kind: "query-run" as const,
        refId: queryRun.id,
        digest: queryRun.resultDigest,
        cutoffAt: queryRun.dataCutoffAt,
      })),
      ...(projectReport === null
        ? []
        : [
            {
              kind: "project-report" as const,
              refId: projectReport.id,
              version: projectReport.version,
              digest: projectReport.digest,
              cutoffAt: projectReport.cutoffAt?.toISOString() ?? null,
            },
          ]),
    ];
    const answerDigest = digest({
      conversationId,
      content: input.content,
      queryRuns: queryRuns.map((run) => ({
        id: run.id,
        resultDigest: run.resultDigest,
      })),
      projectReportId: projectReport?.id ?? null,
      contextRefs,
    });
    const answer = await this.repository.createAnswer({
      conversation,
      content: input.content,
      digest: answerDigest,
      queryRuns,
      projectReport,
      contextRefs,
    });
    await this.audit(actor, "data.agent.answer.created", answer.id, {
      conversationId,
      queryRunIds: answer.queryRunIds,
      projectReportId: answer.projectReportId,
      runId: conversation.runId,
      contextPackId: conversation.contextPackId,
      skillSnapshotDigest: conversation.skillSnapshotDigest,
      digest: answer.digest,
    });
    return answer;
  }

  async getQueryRun(
    queryRunId: string,
    actor: DataFabricActor,
  ): Promise<QueryRun> {
    const queryRun = await this.repository.getQueryRun(queryRunId);
    if (queryRun === undefined) {
      throw new DataFabricApplicationError(
        "data_query_run_not_found",
        "QueryRun not found",
        404,
      );
    }
    await this.requireConversation(queryRun.conversationId, actor, false);
    return queryRun;
  }

  async getQueryResult(
    queryRunId: string,
    actor: DataFabricActor,
  ): Promise<QueryResult> {
    const queryRun = await this.getQueryRun(queryRunId, actor);
    if (queryRun.status !== "completed") {
      throw new DataFabricApplicationError(
        "data_query_result_unavailable",
        "QueryRun did not complete successfully",
        409,
        { queryRunId, status: queryRun.status },
      );
    }
    const result = await this.repository.getQueryResult(queryRunId);
    if (result === undefined) {
      throw new DataFabricApplicationError(
        "data_query_result_missing",
        "Completed QueryRun has no QueryResult",
        409,
      );
    }
    return result;
  }

  async cancelQueryRun(
    queryRunId: string,
    actor: DataFabricActor,
  ): Promise<QueryRun> {
    const current = await this.getQueryRun(queryRunId, actor);
    if (!["queued", "running"].includes(current.status)) {
      throw new DataFabricApplicationError(
        "data_query_run_terminal",
        "QueryRun is already terminal",
        409,
        { queryRunId, status: current.status },
      );
    }
    const cancelled = await this.repository.cancelQueryRun(
      queryRunId,
      actor.principalId,
    );
    this.activeQueries.get(queryRunId)?.abort();
    if (cancelled === undefined) {
      const terminal = await this.repository.getQueryRun(queryRunId);
      if (terminal !== undefined) return terminal;
      throw new DataFabricApplicationError(
        "data_query_run_not_found",
        "QueryRun not found",
        404,
      );
    }
    await this.audit(actor, "query.cancelled", queryRunId, {
      conversationId: current.conversationId,
      datasetId: current.datasetId,
    });
    return cancelled;
  }

  private async createConversationRefs(
    conversation: DataAgentConversation,
    run: DataFabricRunContext,
  ): Promise<void> {
    await this.repository.createContextRef({
      conversationId: conversation.id,
      kind: "run",
      refId: run.runId,
    });
    if (run.contextPackId !== null) {
      await this.repository.createContextRef({
        conversationId: conversation.id,
        kind: "context-pack",
        refId: run.contextPackId,
      });
    }
    if (run.skillSnapshotDigest !== null) {
      await this.repository.createContextRef({
        conversationId: conversation.id,
        kind: "skill-snapshot",
        refId: run.runId,
        digest: run.skillSnapshotDigest,
      });
    }
  }

  private async requireConversation(
    conversationId: string,
    actor: DataFabricActor,
    requireActive: boolean,
  ): Promise<DataAgentConversation> {
    const conversation =
      await this.repository.getConversation(conversationId);
    if (
      conversation === undefined ||
      conversation.requesterPrincipalId !== actor.principalId ||
      (requireActive && conversation.status !== "active")
    ) {
      throw new DataFabricApplicationError(
        "data_agent_conversation_not_found",
        "Data Agent conversation not found",
        404,
      );
    }
    if (await this.repository.hasGuestRole(actor.principalId)) {
      throw new DataFabricApplicationError(
        "data_agent_guest_denied",
        "Guest principals cannot access Data Fabric",
        403,
      );
    }
    return conversation;
  }

  private async authorizeDatasetQuery(
    conversation: DataAgentConversation,
    bundle: DatasetQueryBundle,
    actor: DataFabricActor,
    input: ExecuteDataQueryValue,
  ): Promise<{
    readonly policies: DataPolicyBundle[];
    readonly rowFilters: DataRowFilter[];
    readonly allowed: { allowed: string[]; denied: string[] };
    readonly maxRows: number;
    readonly timeoutMs: number;
    readonly dataCutoffAt: string | null;
    readonly permissionSummary: QueryPermissionSummary;
  }> {
    const guestDenied = await this.repository.hasGuestRole(actor.principalId);
    const agentActive = await this.repository.isAgentActive(
      conversation.agentId,
    );
    const agentPrincipalActive = await this.repository.isAgentPrincipalActive(
      conversation.agentPrincipalId,
    );
    const projectAccess =
      conversation.projectId === bundle.dataset.projectId &&
      (await this.hasProjectRead(actor, bundle.dataset.projectId));
    const workspaceAccess =
      actor.platformAdministrator ||
      (
        await this.authorization.authorizeWorkspace({
          principalId: actor.principalId,
          authSource: actor.authSource,
          workspaceId: bundle.dataset.workspaceId,
          permission: "read",
        })
      ).allowed;
    const runtimeConnectionScope =
      bundle.connection.status === "active" &&
      bundle.connection.allowedRuntimeProfileIds.includes(
        conversation.runtimeProfileId,
      );
    const datasetScope =
      bundle.dataset.status === "active" &&
      bundle.dataset.connectionId === bundle.connection.id &&
      bundle.dataset.projectId === bundle.connection.projectId &&
      bundle.dataset.workspaceId === bundle.connection.workspaceId;
    const policies = bundle.policies.filter(
      (policy) =>
        (policy.policy.scopeType === "project" &&
          policy.policy.scopeId === bundle.dataset.projectId) ||
        (policy.policy.scopeType === "workspace" &&
          policy.policy.scopeId === bundle.dataset.workspaceId),
    );
    if (
      guestDenied ||
      !agentActive ||
      !agentPrincipalActive ||
      !projectAccess ||
      !workspaceAccess ||
      !runtimeConnectionScope ||
      !datasetScope ||
      policies.length === 0
    ) {
      throw new DataFabricApplicationError(
        "data_query_access_denied",
        "Data query access denied",
        403,
        {
          guestDenied,
          agentActive,
          agentPrincipalActive,
          projectAccess,
          workspaceAccess,
          runtimeConnectionScope,
          datasetScope,
          policyCount: policies.length,
        },
      );
    }
    const allowed = effectiveAllowedColumns(bundle, policies);
    const maxRows = Math.min(
      MAX_HARD_ROWS,
      bundle.connection.maxRows,
      bundle.dataset.maxRows,
      input.maxRows ?? MAX_HARD_ROWS,
      ...policies.map((policy) => policy.version.maxRows),
    );
    const timeoutMs = Math.min(
      MAX_HARD_TIMEOUT_MS,
      bundle.connection.timeoutMs,
      bundle.dataset.timeoutMs,
      input.timeoutMs ?? MAX_HARD_TIMEOUT_MS,
      ...policies.map((policy) => policy.version.timeoutMs),
    );
    const dataCutoffAt = earliestCutoff([
      bundle.connection.dataCutoffAt,
      ...policies.map((policy) => policy.version.dataCutoffAt),
    ]);
    const policyVersions = policies.map((policy) => ({
      policyId: policy.policy.id,
      version: policy.version.version,
    }));
    return {
      policies,
      rowFilters: policies.flatMap(
        (policy) => policy.version.rowFilters,
      ),
      allowed,
      maxRows,
      timeoutMs,
      dataCutoffAt,
      permissionSummary: {
        projectAccess,
        workspaceAccess,
        runtimeConnectionScope,
        datasetScope,
        guestDenied,
        rowPolicyVersions: policyVersions,
        columnPolicyVersions: policyVersions,
        allowedColumns: allowed.allowed,
        deniedColumns: allowed.denied,
        maxRows,
        timeoutMs,
        dataCutoffAt,
      },
    };
  }

  private async scanWithTimeout(
    input: DataFabricQueryAdapterInput,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<Array<Record<string, unknown>>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new DataFabricApplicationError(
            "data_query_timeout",
            "QueryRun timed out",
            408,
          ),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.adapter.scan(input), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async canDiscoverDataset(
    dataset: Dataset,
    actor: DataFabricActor,
  ): Promise<boolean> {
    if (await this.repository.hasGuestRole(actor.principalId)) return false;
    if (!(await this.hasProjectRead(actor, dataset.projectId))) return false;
    const workspace =
      actor.platformAdministrator ||
      (
        await this.authorization.authorizeWorkspace({
          principalId: actor.principalId,
          authSource: actor.authSource,
          workspaceId: dataset.workspaceId,
          permission: "read",
        })
      ).allowed;
    if (!workspace) return false;
    const policies = await this.repository.listPolicies(dataset.id);
    return policies.some(
      (policy) =>
        (policy.policy.scopeType === "project" &&
          policy.policy.scopeId === dataset.projectId) ||
        (policy.policy.scopeType === "workspace" &&
          policy.policy.scopeId === dataset.workspaceId),
    );
  }

  private async validatePolicyColumns(
    datasetId: string,
    content: {
      allowedColumns: string[];
      deniedColumns: string[];
      rowFilters: DataRowFilter[];
    },
  ): Promise<void> {
    const columns = new Set(
      (await this.repository.listColumns(datasetId)).map(
        (column) => column.name,
      ),
    );
    const referenced = [
      ...content.allowedColumns,
      ...content.deniedColumns,
      ...content.rowFilters.map((filter) => filter.column),
    ];
    const unknown = referenced.find((column) => !columns.has(column));
    if (unknown !== undefined) {
      throw new DataFabricApplicationError(
        "data_policy_column_not_found",
        `Data policy references unknown column ${unknown}`,
        400,
      );
    }
  }

  private async hasProjectRead(
    actor: DataFabricActor,
    projectId: string,
  ): Promise<boolean> {
    if (actor.platformAdministrator) return true;
    const decision = await this.authorization.getProjectCapability({
      principalId: actor.principalId,
      authSource: actor.authSource,
      projectId,
    });
    return decision.allowed && decision.capability?.capabilities.read === true;
  }

  private assertAdministrator(actor: DataFabricActor): void {
    if (!actor.platformAdministrator) {
      throw new DataFabricApplicationError(
        "data_fabric_admin_required",
        "Platform administrator permission is required",
        403,
      );
    }
  }

  private async assertNotGuest(actor: DataFabricActor): Promise<void> {
    if (await this.repository.hasGuestRole(actor.principalId)) {
      throw new DataFabricApplicationError(
        "data_agent_guest_denied",
        "Guest principals cannot access Data Fabric",
        403,
      );
    }
  }

  private async assertFeatureEnabled(): Promise<void> {
    if ((await this.repository.featureMode()) !== "on") {
      throw new DataFabricApplicationError(
        "data_fabric_disabled",
        "Data Fabric is disabled",
        503,
      );
    }
  }

  private async audit(
    actor: DataFabricActor,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.authorization.audit({
      action,
      decision: "allowed",
      actorPrincipalId: actor.principalId,
      metadata: { resourceId, ...metadata },
    });
  }
}

function aggregateMetric(
  rows: Array<Record<string, unknown>>,
  metric: SemanticMetricVersion,
): number | string | null {
  if (metric.aggregation === "count") return rows.length;
  const values = rows
    .map((row) => row[metric.column])
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  if (metric.aggregation === "sum") {
    return values.reduce((total, value) => total + value, 0);
  }
  if (metric.aggregation === "avg") {
    return values.reduce((total, value) => total + value, 0) / values.length;
  }
  if (metric.aggregation === "min") return Math.min(...values);
  if (metric.aggregation === "max") return Math.max(...values);
  return null;
}

function normalizeQueryFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly status: "failed" | "cancelled" | "timeout";
  readonly statusCode: number;
} {
  if (error instanceof DataFabricApplicationError) {
    if (error.code === "data_query_timeout") {
      return {
        code: error.code,
        message: error.message,
        status: "timeout",
        statusCode: 408,
      };
    }
    if (error.code === "data_query_cancelled") {
      return {
        code: error.code,
        message: error.message,
        status: "cancelled",
        statusCode: 409,
      };
    }
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"))
  ) {
    return {
      code: "data_query_cancelled",
      message: "QueryRun was cancelled",
      status: "cancelled",
      statusCode: 409,
    };
  }
  return {
    code: "data_query_failed",
    message: error instanceof Error ? error.message : "Data query failed",
    status: "failed",
    statusCode: 500,
  };
}
