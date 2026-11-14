import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DataAgentAnswer,
  DataAgentConversation,
  DataAgentConversationDetail,
  DataConnection,
  Dataset,
  QueryResult,
  QueryRun,
} from "@pluginmax/contracts";
import type { DataFabricQueryAdapter } from "@pluginmax/application";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M7 Data Fabric and Data Agent PostgreSQL integration", () => {
  const projectId = randomUUID();
  const workspaceId = "m7-workspace";
  const ownerActor = "m7-owner";
  const guestActor = "m7-guest";
  const outsiderActor = "m7-outsider";
  const agentPrincipalId = "00000000-0000-4000-8000-000000000001";
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let connection: DataConnection;
  let dataset: Dataset;
  let metricId: string;
  let policyId: string;
  let conversation: DataAgentConversation;
  let ownerRunId: string;
  let successfulQueryRun: QueryRun;
  let projectReportId: string;
  let behavior: "normal" | "delay" | "fail" = "normal";
  let delayMs = 0;

  const adapter: DataFabricQueryAdapter = {
    async scan(input) {
      if (behavior === "delay") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (input.signal.aborted) throw new Error("aborted");
      if (behavior === "fail") throw new Error("fixture adapter failed");
      return repositories.dataFabric.readDatasetRows(input.dataset.id);
    },
  };

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m7-")),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
      dataFabricQueryAdapter: adapter,
    });
    app = built.app;
    await app.ready();

    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES
         ('local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($1, 'human', 'M7 Owner', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($2, 'human', 'M7 Guest', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($3, 'human', 'M7 Outsider', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($4, 'ai', 'M7 Fixture Agent', 'active', 'system', 'agent',
          1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [ownerActor, guestActor, outsiderActor, agentPrincipalId],
    );
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'M7 Data Fabric', $2, '', 'active', NOW(), NOW())`,
      [projectId, `M7-${projectId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO workspaces (
         id, display_name, status, created_by_principal_id, version,
         created_at, updated_at
       ) VALUES ($1, 'M7 Workspace', 'active', 'local-admin', 1, NOW(), NOW())`,
      [workspaceId],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, version, created_at, updated_at
       ) VALUES
         ($1, $3, $4, 'active', 1, NOW(), NOW()),
         ($2, $3, $5, 'active', 1, NOW(), NOW())`,
      [
        randomUUID(),
        randomUUID(),
        workspaceId,
        ownerActor,
        guestActor,
      ],
    );
    await database.query(
      `INSERT INTO project_members (
         id, project_id, kind, actor_id, principal_id, name, responsibility,
         status, is_owner, created_at, updated_at
       ) VALUES
         ($1, $3, 'human', $4, $4, 'M7 Owner', '', 'active', FALSE,
          NOW(), NOW()),
         ($2, $3, 'human', $5, $5, 'M7 Guest', '', 'active', FALSE,
          NOW(), NOW())`,
      [
        randomUUID(),
        randomUUID(),
        projectId,
        ownerActor,
        guestActor,
      ],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES
         ($1, $3, 'project', $5, 'MEMBER', '["read"]'::jsonb,
          'active', 'manual', 'm7-owner', 'local-admin', NULL, NOW(), NULL,
          NULL, 1, NOW(), NOW()),
         ($2, $4, 'project', $5, 'GUEST', '["read","write"]'::jsonb,
          'active', 'manual', 'm7-guest', 'local-admin', NULL, NOW(), NULL,
          NULL, 1, NOW(), NOW())`,
      [
        randomUUID(),
        randomUUID(),
        ownerActor,
        guestActor,
        projectId,
      ],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES
         ($1, $3, 'workspace', $5, 'MEMBER', '["read"]'::jsonb,
          'active', 'manual', 'm7-owner-workspace', 'local-admin', NULL,
          NOW(), NULL, NULL, 1, NOW(), NOW()),
         ($2, $4, 'workspace', $5, 'GUEST', '["read"]'::jsonb,
          'active', 'manual', 'm7-guest-workspace', 'local-admin', NULL,
          NOW(), NULL, NULL, 1, NOW(), NOW())`,
      [
        randomUUID(),
        randomUUID(),
        ownerActor,
        guestActor,
        workspaceId,
      ],
    );
    ownerRunId = await insertRun(projectId, "fixture-runtime", "M7 owner run");
    await insertRun(
      projectId,
      "unscoped-runtime",
      "M7 runtime mismatch",
    );
    const guestRunId = await insertRun(
      projectId,
      "fixture-runtime",
      "M7 guest run",
    );

    await setFlag("on");
    connection = await request<DataConnection>(
      "POST",
      "/api/v1/data-fabric/connections",
      {
        workspaceId,
        projectId,
        name: "M7 Fixture Connection",
        allowedRuntimeProfileIds: ["fixture-runtime"],
        maxRows: 10,
        timeoutMs: 5_000,
        dataCutoffAt: "2026-11-12T00:00:00.000Z",
      },
      "local-admin",
      201,
    );
    dataset = await request<Dataset>(
      "POST",
      "/api/v1/data-fabric/datasets",
      {
        connectionId: connection.id,
        key: "orders",
        name: "Orders",
        description: "Read-only orders fixture",
        maxRows: 5,
        timeoutMs: 5_000,
      },
      "local-admin",
      201,
    );
    await request("POST", `/api/v1/data-fabric/datasets/${dataset.id}/columns`, {
      name: "tenant_id",
      dataType: "string",
      position: 0,
      sensitive: false,
    }, "local-admin", 201);
    await request("POST", `/api/v1/data-fabric/datasets/${dataset.id}/columns`, {
      name: "amount",
      dataType: "number",
      position: 1,
      sensitive: false,
    }, "local-admin", 201);
    await request("POST", `/api/v1/data-fabric/datasets/${dataset.id}/columns`, {
      name: "secret",
      dataType: "string",
      position: 2,
      sensitive: true,
    }, "local-admin", 201);
    const metric = await request<{ metric: { id: string } }>(
      "POST",
      `/api/v1/data-fabric/datasets/${dataset.id}/metrics`,
      {
        key: "row-count",
        title: "Row count",
        content: {
          aggregation: "count",
          column: "tenant_id",
          description: "Count rows after row policy",
          format: "integer",
        },
      },
      "local-admin",
      201,
    );
    metricId = metric.metric.id;
    const policy = await request<{ policy: { id: string } }>(
      "POST",
      `/api/v1/data-fabric/datasets/${dataset.id}/policies`,
      {
        scopeType: "project",
        scopeId: projectId,
        content: {
          rowFilters: [
            { column: "tenant_id", operator: "eq", values: ["tenant-a"] },
          ],
          allowedColumns: [],
          deniedColumns: ["secret"],
          maxRows: 2,
          timeoutMs: 5_000,
          dataCutoffAt: "2026-11-12T01:00:00.000Z",
        },
      },
      "local-admin",
      201,
    );
    policyId = policy.policy.id;
    await database.query(
      `INSERT INTO dataset_rows (
         id, dataset_id, row_key, row_data, created_at
       ) VALUES
         ($1, $7, 'a-1', '{"tenant_id":"tenant-a","amount":10,"secret":"x"}',
          NOW()),
         ($2, $7, 'a-2', '{"tenant_id":"tenant-a","amount":20,"secret":"x"}',
          NOW()),
         ($3, $7, 'a-3', '{"tenant_id":"tenant-a","amount":30,"secret":"x"}',
          NOW()),
         ($4, $7, 'b-1', '{"tenant_id":"tenant-b","amount":40,"secret":"y"}',
          NOW()),
         ($5, $7, 'b-2', '{"tenant_id":"tenant-b","amount":50,"secret":"y"}',
          NOW()),
         ($6, $7, 'b-3', '{"tenant_id":"tenant-b","amount":60,"secret":"y"}',
          NOW())`,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        dataset.id,
      ],
    );

    conversation = (
      await request<{ conversation: DataAgentConversation }>(
        "POST",
        "/api/v1/data-agent/conversations",
        { runId: ownerRunId, title: "M7 sales" },
        ownerActor,
        201,
      )
    ).conversation;
    guestRunIdForAssertion = guestRunId;
    projectReportId = randomUUID();
    await database.query(
      `INSERT INTO project_reports (
         id, project_id, report_date, version, content_hash, snapshot,
         generated_by, generated_at
       ) VALUES (
         $1, $2, '2026-11-12', 1, $3, '{
           "projectName":"M7 Data Fabric",
           "projectCode":"M7-DATA",
           "periodStart":"2026-11-11T16:00:00.000Z",
           "periodEnd":"2026-11-12T16:00:00.000Z",
           "counts":{
             "tasks":0,"runs":1,"reviews":0,"workflows":0,
             "meetings":0,"actionItems":0,"memory":0
           },
           "items":[]
         }'::jsonb, 'local-admin', '2026-11-12T17:00:00.000Z'
       )`,
      [projectReportId, projectId, "a".repeat(64)],
    );
  });

  let guestRunIdForAssertion: string;
  let mismatchRunId: string;

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function setFlag(mode: "on" | "off"): Promise<void> {
    await database.query(
      `UPDATE feature_flag_settings
       SET mode = $1, revision = revision + 1, updated_at = NOW()
       WHERE flag_key = 'data_fabric'
         AND scope_type = 'platform'
         AND scope_id = 'platform'`,
      [mode],
    );
  }

  async function insertRun(
    runProjectId: string,
    runtimeProfileId: string,
    title: string,
  ): Promise<string> {
    const taskId = randomUUID();
    const runId = randomUUID();
    const contextPackId = randomUUID();
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status, agent_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'M7 Data Agent run', '[]'::jsonb, 'in_progress',
         $4, NOW(), NOW()
       )`,
      [taskId, runProjectId, title, agentPrincipalId],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, agent_principal_id, status,
         input_snapshot, execution_envelope_snapshot, observability, attempt,
         context_pack_id, initiated_by_principal_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'running', '{}'::jsonb, $6::jsonb, '{}'::jsonb,
         1, $7, $8, NOW(), NOW()
       )`,
      [
        runId,
        runProjectId,
        taskId,
        agentPrincipalId,
        agentPrincipalId,
        JSON.stringify({
          agentPrincipalId,
          runtime: { id: runtimeProfileId, revision: 1 },
        }),
        contextPackId,
        ownerActor,
      ],
    );
    await database.query(
      `INSERT INTO context_packs (
         id, run_id, project_id, task_id, agent_id, pack, receipt,
         content_hash, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb, $6, NOW()
       )`,
      [
        contextPackId,
        runId,
        runProjectId,
        taskId,
        agentPrincipalId,
        "b".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO run_skill_snapshots (
         run_id, platform_safety_rules, skills, snapshot_digest, captured_at
       ) VALUES (
         $1, '["skill.no_authorization"]'::jsonb, '[]'::jsonb, $2, NOW()
       )`,
      [runId, "c".repeat(64)],
    );
    if (runtimeProfileId === "unscoped-runtime") {
      mismatchRunId = runId;
    }
    return runId;
  }

  async function request<T>(
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    expectedStatus = 200,
  ): Promise<T> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    const body =
      response.body === "" ? undefined : (response.json() as unknown);
    expect(
      response.statusCode,
      `${method} ${url}: ${JSON.stringify(body)}`,
    ).toBe(expectedStatus);
    return body as T;
  }

  async function rawRequest(
    method: "GET" | "POST",
    url: string,
    payload: unknown,
    actorId: string,
  ) {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
      payload: payload as Record<string, unknown>,
    };
    return app.inject(options);
  }

  async function latestQueryRun(
    conversationId: string,
  ): Promise<QueryRun | undefined> {
    const result = await database.query<{ id: string }>(
      `SELECT id
       FROM query_runs
       WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [conversationId],
    );
    const id = result.rows[0]?.id;
    return id === undefined
      ? undefined
      : repositories.dataFabric.getQueryRun(id);
  }

  it("keeps data_fabric disabled for new queries", async () => {
    await setFlag("off");
    const response = await rawRequest(
      "POST",
      `/api/v1/data-agent/conversations/${conversation.id}/messages`,
      { content: "must be rejected" },
      ownerActor,
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "data_fabric_disabled" });
    await setFlag("on");
  });

  it("does not reveal datasets without Project and Workspace access", async () => {
    const list = await request<{ items: Dataset[] }>(
      "GET",
      `/api/v1/data-fabric/datasets?projectId=${projectId}`,
      undefined,
      outsiderActor,
    );
    expect(list.items).toEqual([]);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/data-fabric/datasets/${dataset.id}`,
      headers: { "x-pluginmax-actor": outsiderActor },
    });
    expect(detail.statusCode).toBe(404);
  });

  it("denies Guest access even with Project and Workspace membership", async () => {
    const response = await rawRequest(
      "POST",
      "/api/v1/data-agent/conversations",
      { runId: guestRunIdForAssertion, title: "Guest query" },
      guestActor,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "data_agent_guest_denied" });
  });

  it("derives Runtime Profile scope from Run and rejects mismatches", async () => {
    const mismatchConversation = await request<{
      conversation: DataAgentConversation;
    }>(
      "POST",
      "/api/v1/data-agent/conversations",
      { runId: mismatchRunId, title: "Wrong runtime" },
      ownerActor,
      201,
    );
    const response = await rawRequest(
      "POST",
      `/api/v1/data-agent/conversations/${mismatchConversation.conversation.id}/queries`,
      {
        mode: "dataset",
        datasetId: dataset.id,
        columns: ["tenant_id"],
      },
      ownerActor,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "data_query_access_denied",
      details: { runtimeConnectionScope: false },
    });
  });

  it("rejects denied columns and stores a failed QueryRun without a result", async () => {
    const response = await rawRequest(
      "POST",
      `/api/v1/data-agent/conversations/${conversation.id}/queries`,
      {
        mode: "dataset",
        datasetId: dataset.id,
        columns: ["secret"],
      },
      ownerActor,
    );
    expect(response.statusCode).toBe(403);
    const body = response.json() as {
      code: string;
      details: { queryRunId: string };
    };
    expect(body.code).toBe("data_column_denied");
    const failed = await repositories.dataFabric.getQueryRun(
      body.details.queryRunId,
    );
    expect(failed).toMatchObject({
      status: "failed",
      deniedColumns: ["secret"],
      rowCount: null,
      resultDigest: null,
    });
    expect(
      await repositories.dataFabric.getQueryResult(failed!.id),
    ).toBeUndefined();
  });

  it("applies row filters, query limits, and result digest", async () => {
    const response = await request<{
      queryRun: QueryRun;
      result: QueryResult;
    }>(
      "POST",
      `/api/v1/data-agent/conversations/${conversation.id}/queries`,
      {
        mode: "dataset",
        datasetId: dataset.id,
        columns: ["tenant_id", "amount"],
        maxRows: 1,
      },
      ownerActor,
    );
    successfulQueryRun = response.queryRun;
    expect(response.queryRun).toMatchObject({
      status: "completed",
      scanCount: 6,
      rowCount: 1,
      maxRows: 1,
      deniedColumns: ["secret"],
      skillSnapshotDigest: "c".repeat(64),
      connectionVersion: 1,
      datasetVersion: 1,
      requesterPrincipalId: ownerActor,
      agentPrincipalId,
      dataCutoffAt: "2026-11-12T00:00:00.000Z",
    });
    expect(response.queryRun.contextPackId).toBeTruthy();
    expect(response.result.rows).toEqual([
      { tenant_id: "tenant-a", amount: 10 },
    ]);
    expect(response.result.digest).toBe(response.queryRun.resultDigest);
    expect(response.result.digest).toMatch(/^[a-f0-9]{64}$/);
    const fetched = await request<QueryResult>(
      "GET",
      `/api/v1/data-agent/query-runs/${response.queryRun.id}/result`,
      undefined,
      ownerActor,
    );
    expect(fetched).toEqual(response.result);
  });

  it("runs bounded semantic metrics without arbitrary SQL", async () => {
    const metric = await request<{
      queryRun: QueryRun;
      result: QueryResult;
    }>(
      "POST",
      `/api/v1/data-agent/conversations/${conversation.id}/queries`,
      { mode: "metric", metricId },
      ownerActor,
    );
    expect(metric.result.rows).toEqual([{ "row-count": 3 }]);
    expect(metric.queryRun.metricVersion).toBe(1);
    const freeSql = await rawRequest(
      "POST",
      `/api/v1/data-agent/conversations/${conversation.id}/queries`,
      {
        mode: "dataset",
        datasetId: dataset.id,
        sql: "select * from orders",
      },
      ownerActor,
    );
    expect(freeSql.statusCode).toBe(400);
  });

  it("times out without writing a QueryResult", async () => {
    behavior = "delay";
    delayMs = 100;
    try {
      const response = await rawRequest(
        "POST",
        `/api/v1/data-agent/conversations/${conversation.id}/queries`,
        {
          mode: "dataset",
          datasetId: dataset.id,
          columns: ["tenant_id"],
          timeoutMs: 5,
        },
        ownerActor,
      );
      expect(response.statusCode).toBe(408);
      const body = response.json() as {
        code: string;
        details: { queryRunId: string };
      };
      expect(body.code).toBe("data_query_timeout");
      const timedOut = await repositories.dataFabric.getQueryRun(
        body.details.queryRunId,
      );
      expect(timedOut).toMatchObject({
        status: "timeout",
        resultDigest: null,
        rowCount: null,
      });
      expect(
        await repositories.dataFabric.getQueryResult(
          body.details.queryRunId,
        ),
      ).toBeUndefined();
    } finally {
      behavior = "normal";
      delayMs = 0;
    }
  });

  it("cancels a running QueryRun without returning a fake result", async () => {
    behavior = "delay";
    delayMs = 200;
    try {
      const pending = rawRequest(
        "POST",
        `/api/v1/data-agent/conversations/${conversation.id}/queries`,
        {
          mode: "dataset",
          datasetId: dataset.id,
          columns: ["tenant_id"],
        },
        ownerActor,
      );
      let running: QueryRun | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        running = await latestQueryRun(conversation.id);
        if (running?.status === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(running?.status).toBe("running");
      const cancelled = await request<QueryRun>(
        "POST",
        `/api/v1/data-agent/query-runs/${running!.id}/cancel`,
        {},
        ownerActor,
      );
      expect(cancelled.status).toBe("cancelled");
      const pendingResponse = await pending;
      expect(pendingResponse.statusCode).toBe(409);
      expect(
        await repositories.dataFabric.getQueryResult(running!.id),
      ).toBeUndefined();
    } finally {
      behavior = "normal";
      delayMs = 0;
    }
  });

  it("marks adapter failures as failed and never persists fake rows", async () => {
    behavior = "fail";
    try {
      const response = await rawRequest(
        "POST",
        `/api/v1/data-agent/conversations/${conversation.id}/queries`,
        {
          mode: "dataset",
          datasetId: dataset.id,
          columns: ["tenant_id"],
        },
        ownerActor,
      );
      expect(response.statusCode).toBe(500);
      const body = response.json() as {
        code: string;
        details: { queryRunId: string };
      };
      expect(body.code).toBe("data_query_failed");
      const failed = await repositories.dataFabric.getQueryRun(
        body.details.queryRunId,
      );
      expect(failed).toMatchObject({
        status: "failed",
        resultDigest: null,
        rowCount: null,
      });
      expect(
        await repositories.dataFabric.getQueryResult(
          body.details.queryRunId,
        ),
      ).toBeUndefined();
    } finally {
      behavior = "normal";
    }
  });

  it("keeps historical QueryRun policy snapshots immutable", async () => {
    await request(
      "POST",
      `/api/v1/data-fabric/datasets/${dataset.id}/policies/${policyId}/versions`,
      {
        expectedCurrentVersion: 1,
        content: {
          rowFilters: [
            { column: "tenant_id", operator: "eq", values: ["tenant-b"] },
          ],
          allowedColumns: [],
          deniedColumns: ["secret"],
          maxRows: 2,
          timeoutMs: 5_000,
        },
      },
      "local-admin",
      201,
    );
    const historical = await repositories.dataFabric.getQueryRun(
      successfulQueryRun.id,
    );
    expect(historical?.rowFilters).toEqual([
      { column: "tenant_id", operator: "eq", values: ["tenant-a"] },
    ]);
    expect(historical?.policySnapshot[0]?.version).toBe(1);
    const newResult = await request<{
      queryRun: QueryRun;
      result: QueryResult;
    }>(
      "POST",
      `/api/v1/data-agent/conversations/${conversation.id}/queries`,
      {
        mode: "dataset",
        datasetId: dataset.id,
        columns: ["tenant_id"],
      },
      ownerActor,
    );
    expect(newResult.result.rows).toEqual([
      { tenant_id: "tenant-b" },
      { tenant_id: "tenant-b" },
    ]);
    expect(newResult.queryRun.policySnapshot[0]?.version).toBe(2);
  });

  it("reuses M6 Project Report, Run, ContextPack and Skill Snapshot facts", async () => {
    const before = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM project_reports WHERE project_id = $1",
      [projectId],
    );
    const answer = await request<DataAgentAnswer>(
      "POST",
      `/api/v1/data-agent/conversations/${conversation.id}/reports`,
      {
        content: "Revenue is traceable to the bounded QueryRun and M6 report.",
        queryRunIds: [successfulQueryRun.id],
        projectReportId,
      },
      ownerActor,
      201,
    );
    expect(answer).toMatchObject({
      projectReportId,
      runId: ownerRunId,
      contextPackId: successfulQueryRun.contextPackId,
      skillSnapshotDigest: "c".repeat(64),
      queryRunIds: [successfulQueryRun.id],
    });
    const after = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM project_reports WHERE project_id = $1",
      [projectId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const refs = await repositories.dataFabric.listContextRefs(
      conversation.id,
    );
    expect(refs.map((ref) => ref.kind)).toEqual(
      expect.arrayContaining([
        "run",
        "context-pack",
        "skill-snapshot",
        "project-report",
        "query-run",
      ]),
    );
    const detail = await request<DataAgentConversationDetail>(
      "GET",
      `/api/v1/data-agent/conversations/${conversation.id}`,
      undefined,
      ownerActor,
    );
    expect(detail.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: answer.id, projectReportId }),
      ]),
    );
    expect(detail.queryRuns.map((run) => run.id)).toContain(
      successfulQueryRun.id,
    );
  });
});
