import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, migrate, todayInShanghai } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

function tomorrowInShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 86_400_000));
}

interface Project {
  readonly id: string;
  readonly name: string;
}

interface ProjectReport {
  readonly id: string;
  readonly reportDate: string;
  readonly version: number;
  readonly read: boolean;
  readonly readOnly: boolean;
  readonly canGenerate: boolean;
  readonly snapshot: {
    readonly counts: Record<string, number>;
    readonly items: Array<{
      readonly id: string;
      readonly sourceRefs: Array<{
        readonly kind: string;
        readonly id: string;
        readonly available: boolean;
      }>;
    }>;
  };
  readonly sources: Array<{
    readonly kind: string;
    readonly id: string;
    readonly available: boolean;
  }>;
}

interface ReportFixture {
  readonly project: Project;
  readonly taskId: string;
  readonly runId: string;
  readonly reviewId: string;
  readonly workflowId: string;
  readonly meetingId: string;
  readonly minutesVersionId: string;
  readonly actionItemId: string;
  readonly memoryTopicId: string;
  readonly memoryTruthId: string;
}

integration("workbench and project reports", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-workbench-reports-test-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 31,
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    idempotencyKey?: string,
  ): Promise<{ statusCode: number; body: T }> {
    const headers: Record<string, string> = {
      "x-pluginmax-actor": actorId,
    };
    if (idempotencyKey !== undefined) {
      headers["idempotency-key"] = idempotencyKey;
    }
    const options: InjectOptions = {
      method,
      url,
      headers,
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function createProject(label: string): Promise<Project> {
    const result = await request<Project>("POST", "/api/v1/projects", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "Batch 11A integration fixture",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createReportFixture(label: string): Promise<ReportFixture> {
    const project = await createProject(label);
    const taskId = randomUUID();
    const runId = randomUUID();
    const reviewId = randomUUID();
    const workflowDefinitionId = randomUUID();
    const workflowId = randomUUID();
    const meetingId = randomUUID();
    const minutesVersionId = randomUUID();
    const actionItemId = randomUUID();
    const memoryTopicId = randomUUID();
    const memoryTruthId = randomUUID();
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'Review traceable delivery', 'Report integration task',
         '["Evidence is linked"]'::jsonb, 'review',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [taskId, project.id],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         observability, created_at, updated_at
       ) VALUES (
         $1, $2, $3, '00000000-0000-4000-8000-000000000001',
         'completed',
         '{"taskTitle":"Review traceable delivery"}'::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         NOW(), NOW()
       )`,
      [runId, project.id, taskId],
    );
    await database.query(
      `INSERT INTO task_reviews (
         id, task_id, decision, note, actor_id, created_at
       ) VALUES ($1, $2, 'approve', 'Accepted', 'local-admin', NOW())`,
      [reviewId, taskId],
    );
    await database.query(
      `INSERT INTO workflow_definitions (
         id, project_id, name, description, steps, status, created_at, updated_at
       ) VALUES (
         $1, $2, 'Report workflow', '', '[]'::jsonb, 'active', NOW(), NOW()
       )`,
      [workflowDefinitionId, project.id],
    );
    await database.query(
      `INSERT INTO workflow_instances (
         id, workflow_id, project_id, title, status, current_step,
         steps, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'Active report workflow', 'active', 0,
         '[]'::jsonb, NOW(), NOW()
       )`,
      [workflowId, workflowDefinitionId, project.id],
    );
    await database.query(
      `UPDATE runs
       SET workflow_instance_id = $1, workflow_node_id = 'execute'
       WHERE id = $2`,
      [workflowId, runId],
    );
    await database.query(
      `INSERT INTO meetings (
         id, project_id, title, agenda, status, participants, summary,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'Report decision meeting', '', 'closed', '[]'::jsonb,
         'Decision: preserve the report source chain.', NOW(), NOW()
       )`,
      [meetingId, project.id],
    );
    await database.query(
      `INSERT INTO meeting_minutes_drafts (
         id, meeting_id, project_id, content, decisions, source_message_ids,
         revision, updated_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'Decision: preserve the report source chain.',
         '["Preserve the report source chain"]'::jsonb, '{}'::uuid[],
         1, 'local-admin', NOW(), NOW()
       )`,
      [randomUUID(), meetingId, project.id],
    );
    await database.query(
      `INSERT INTO meeting_minutes_versions (
         id, meeting_id, project_id, version, content, decisions,
         source_message_ids, published_by, published_at
       ) VALUES (
         $1, $2, $3, 1, 'Decision: preserve the report source chain.',
         '["Preserve the report source chain"]'::jsonb, '{}'::uuid[],
         'local-admin', NOW()
       )`,
      [minutesVersionId, meetingId, project.id],
    );
    await database.query(
      `INSERT INTO meeting_action_items (
         id, meeting_id, project_id, title, description, owner_kind,
         owner_actor_id, owner_name, due_at, priority, source_type,
         source_id, source_version_id, source_message_ids, status,
         dedupe_key, task_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'Report follow-up', '', 'human', 'local-admin',
         'Local Admin', NOW() + INTERVAL '1 day', 'high', 'minutes_version',
         $4, $5, '{}'::uuid[], 'open', 'report-follow-up', $6, NOW(), NOW()
       )`,
      [
        actionItemId,
        meetingId,
        project.id,
        minutesVersionId,
        minutesVersionId,
        taskId,
      ],
    );
    await database.query(
      `INSERT INTO memory_topics (
         id, project_id, title, created_at, updated_at
       ) VALUES ($1, $2, 'Report memory', NOW(), NOW())`,
      [memoryTopicId, project.id],
    );
    await database.query(
      `INSERT INTO memory_truths (
         id, topic_id, project_id, content, version, source_type,
         source_id, created_at
       ) VALUES (
         $1, $2, $3, 'Report memory is traceable.', 1, 'task', $4, NOW()
       )`,
      [memoryTruthId, memoryTopicId, project.id, taskId],
    );
    return {
      project,
      taskId,
      runId,
      reviewId,
      workflowId,
      meetingId,
      minutesVersionId,
      actionItemId,
      memoryTopicId,
      memoryTruthId,
    };
  }

  it("generates one immutable version under concurrent refresh and keeps source refs", async () => {
    const fixture = await createReportFixture("Report concurrency");
    const date = todayInShanghai();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request<{
          report: ProjectReport;
          created: boolean;
          reused: boolean;
        }>("POST", `/api/v1/projects/${fixture.project.id}/reports/generate`, {
          reportDate: date,
        }),
      ),
    );
    expect(results.every((result) => result.statusCode === 200)).toBe(true);
    const reportIds = new Set(results.map((result) => result.body.report.id));
    expect(reportIds.size).toBe(1);
    expect(results.filter((result) => result.body.created)).toHaveLength(1);
    expect(results.filter((result) => result.body.reused)).toHaveLength(5);
    const report = results[0]!.body.report;
    expect(report.version).toBe(1);
    expect(report.snapshot.counts).toMatchObject({
      tasks: 1,
      runs: 1,
      reviews: 1,
      workflows: 1,
      meetings: 1,
      actionItems: 1,
      memory: 1,
    });
    expect(report.sources.map((source) => source.kind)).toEqual(
      expect.arrayContaining([
        "task",
        "run",
        "review",
        "workflow",
        "meeting",
        "minutes-version",
        "action-item",
        "memory-topic",
        "memory-truth",
      ]),
    );
    const count = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM project_reports
       WHERE project_id = $1 AND report_date = $2`,
      [fixture.project.id, date],
    );
    expect(count.rows[0]?.count).toBe("1");

    await database.query(
      `UPDATE tasks
       SET title = 'Reviewed traceable delivery', status = 'done', updated_at = NOW()
       WHERE id = $1`,
      [fixture.taskId],
    );
    const refreshed = await request<{
      report: ProjectReport;
      created: boolean;
    }>("POST", `/api/v1/projects/${fixture.project.id}/reports/generate`, {
      reportDate: date,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body.created).toBe(true);
    expect(refreshed.body.report.id).not.toBe(report.id);
    expect(refreshed.body.report.version).toBe(2);
    const original = await request<ProjectReport>(
      "GET",
      `/api/v1/projects/${fixture.project.id}/reports/${report.id}`,
    );
    expect(original.body.version).toBe(1);
    expect(original.body.snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Review traceable delivery"),
        }),
      ]),
    );

    const marked = await request(
      "POST",
      `/api/v1/projects/${fixture.project.id}/reports/${report.id}/read`,
      { read: true },
    );
    expect(marked.statusCode).toBe(200);
    const list = await request<{ items: ProjectReport[] }>(
      "GET",
      `/api/v1/projects/${fixture.project.id}/reports`,
    );
    expect(list.body.items.find((item) => item.id === report.id)).toMatchObject(
      {
        id: report.id,
        read: true,
        version: 1,
      },
    );
  });

  it("enforces cross-project, permission, archive, empty and deleted-source boundaries", async () => {
    const first = await createReportFixture("Report boundary");
    const second = await createProject("Report boundary second");
    const generated = await request<{ report: ProjectReport }>(
      "POST",
      `/api/v1/projects/${first.project.id}/reports/generate`,
      { reportDate: "2026-10-25" },
    );
    expect(generated.statusCode).toBe(200);

    const crossProject = await request(
      "GET",
      `/api/v1/projects/${second.id}/reports/${generated.body.report.id}`,
    );
    expect(crossProject.statusCode).toBe(404);
    const unauthorized = await request(
      "GET",
      `/api/v1/projects/${first.project.id}/reports`,
      undefined,
      "outside-member",
    );
    expect(unauthorized.statusCode).toBe(403);
    const unauthorizedGenerate = await request(
      "POST",
      `/api/v1/projects/${first.project.id}/reports/generate`,
      { reportDate: "2026-10-25" },
      "outside-member",
    );
    expect(unauthorizedGenerate.statusCode).toBe(403);

    await request("PATCH", `/api/v1/projects/${first.project.id}`, {
      status: "archived",
    });
    const archivedGenerate = await request(
      "POST",
      `/api/v1/projects/${first.project.id}/reports/generate`,
      { reportDate: "2026-10-25" },
    );
    expect(archivedGenerate.statusCode).toBe(409);
    const archivedList = await request<{ items: ProjectReport[] }>(
      "GET",
      `/api/v1/projects/${first.project.id}/reports`,
    );
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.body.items[0]).toMatchObject({
      readOnly: true,
      canGenerate: false,
    });

    const empty = await createProject("Empty report");
    const emptyReport = await request<{ report: ProjectReport }>(
      "POST",
      `/api/v1/projects/${empty.id}/reports/generate`,
      { reportDate: "2026-10-24" },
    );
    expect(emptyReport.statusCode).toBe(200);
    expect(emptyReport.body.report.snapshot.items).toEqual([
      expect.objectContaining({ id: "empty" }),
    ]);
    expect(emptyReport.body.report.snapshot.counts.tasks).toBe(0);

    const removable = await createProject("Deleted report source");
    const removableTaskId = randomUUID();
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'Soon deleted task', 'Deleted source fixture',
         '[]'::jsonb, 'queued',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [removableTaskId, removable.id],
    );
    const removableReport = await request<{ report: ProjectReport }>(
      "POST",
      `/api/v1/projects/${removable.id}/reports/generate`,
      { reportDate: "2026-10-23" },
    );
    await database.query("DELETE FROM tasks WHERE id = $1", [removableTaskId]);
    const afterDelete = await request<ProjectReport>(
      "GET",
      `/api/v1/projects/${removable.id}/reports/${removableReport.body.report.id}`,
    );
    expect(afterDelete.statusCode).toBe(200);
    const deletedTaskSource = afterDelete.body.sources.find(
      (source) => source.kind === "task",
    );
    expect(deletedTaskSource).toMatchObject({
      id: removableTaskId,
      available: false,
    });
    expect(
      afterDelete.body.snapshot.items
        .flatMap((item) => item.sourceRefs)
        .find((source) => source.id === removableTaskId),
    ).toMatchObject({ available: false });
  });

  it("builds a persisted workbench brief from reports, follows and real risk rows", async () => {
    const fixture = await createReportFixture("Workbench dashboard");
    const report = await request<{ report: ProjectReport }>(
      "POST",
      `/api/v1/projects/${fixture.project.id}/reports/generate`,
      { reportDate: todayInShanghai() },
    );
    expect(report.statusCode).toBe(200);
    const supply = await request(
      "POST",
      "/api/v1/workbench/supply-exceptions",
      {
        projectId: fixture.project.id,
        title: "Persisted valve shortage",
        severity: "high",
        suggestedAction: "Qualify the backup supplier.",
        ownerActorId: "local-admin",
        impactScope: "Assembly line A",
        sourceTaskId: fixture.taskId,
        status: "open",
      },
    );
    expect(supply.statusCode).toBe(201);
    const supplier = await request("POST", "/api/v1/workbench/supplier-risks", {
      projectId: fixture.project.id,
      supplierName: "Persisted Supplier",
      riskType: "Capacity",
      riskScore: 82,
      commitmentRate: 71.5,
      qualityMetric: "Three recent deviations",
      purchaseShare: 34,
      suggestedAction: "Start a capacity review.",
      status: "open",
      sourceNote: "Loaded from supplier_risks",
    });
    expect(supplier.statusCode).toBe(201);
    await request("POST", "/api/v1/workbench/follows", {
      targetType: "project",
      targetId: fixture.project.id,
      projectId: fixture.project.id,
      followed: true,
    });
    await request("POST", "/api/v1/workbench/follows", {
      targetType: "workflow",
      targetId: fixture.workflowId,
      projectId: fixture.project.id,
      followed: true,
    });
    const follow = await request("POST", "/api/v1/workbench/follows", {
      targetType: "task",
      targetId: fixture.taskId,
      projectId: fixture.project.id,
      followed: true,
    });
    expect(follow.statusCode).toBe(200);

    const dashboard = await request<{
      brief: { id: string; snapshot: { items: unknown[] } };
      todos: Array<{ taskId: string }>;
      focus: Array<{
        id: string;
        directFollow: boolean;
        followPriority: number;
        followReason: string;
      }>;
      meetingConclusions: Array<{ meetingId: string }>;
      runExceptions: unknown[];
      projectReports: Array<{ id: string }>;
      supplyExceptions: Array<{ title: string }>;
      supplierRisks: Array<{ supplierName: string; riskScore: number }>;
      settings: { frequency: string };
    }>("GET", "/api/v1/workbench/dashboard");
    expect(dashboard.statusCode).toBe(200);
    expect(
      dashboard.body.todos.some((todo) => todo.taskId === fixture.taskId),
    ).toBe(true);
    expect(
      dashboard.body.focus.find((item) => item.id === fixture.taskId),
    ).toMatchObject({
      directFollow: true,
      followPriority: 5,
    });
    expect(
      dashboard.body.projectReports.some(
        (item) => item.id === report.body.report.id,
      ),
    ).toBe(true);
    expect(dashboard.body.meetingConclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ meetingId: fixture.meetingId }),
      ]),
    );
    expect(dashboard.body.supplyExceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Persisted valve shortage" }),
      ]),
    );
    expect(dashboard.body.supplierRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supplierName: "Persisted Supplier",
          riskScore: 82,
        }),
      ]),
    );

    const settings = await request(
      "PATCH",
      "/api/v1/workbench/brief/settings",
      { frequency: "every-4-hours" },
    );
    expect(settings.statusCode).toBe(200);
    expect((settings.body as { frequency: string }).frequency).toBe(
      "every-4-hours",
    );

    const briefCountBefore = Number(
      (
        await database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM workbench_briefs
           WHERE actor_id = 'local-admin' AND brief_date = $1`,
          [tomorrowInShanghai()],
        )
      ).rows[0]?.count ?? "0",
    );
    const refreshes = await Promise.all(
      Array.from({ length: 5 }, () =>
        request<{ brief: { id: string }; created: boolean }>(
          "POST",
          "/api/v1/workbench/brief/refresh",
          { briefDate: tomorrowInShanghai() },
        ),
      ),
    );
    expect(refreshes.every((result) => result.statusCode === 200)).toBe(true);
    expect(new Set(refreshes.map((result) => result.body.brief.id)).size).toBe(
      1,
    );
    expect(refreshes.filter((result) => result.body.created)).toHaveLength(1);
    const briefCount = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workbench_briefs
       WHERE actor_id = 'local-admin' AND brief_date = $1`,
      [tomorrowInShanghai()],
    );
    expect(Number(briefCount.rows[0]?.count)).toBe(briefCountBefore + 1);

    const unfollow = await request("POST", "/api/v1/workbench/follows", {
      targetType: "task",
      targetId: fixture.taskId,
      projectId: fixture.project.id,
      followed: false,
    });
    expect(unfollow.statusCode).toBe(200);
    const afterUnfollow = await request<{
      focus: Array<{
        id: string;
        directFollow: boolean;
        followPriority: number;
        followReason: string;
      }>;
    }>("GET", "/api/v1/workbench/dashboard");
    expect(
      afterUnfollow.body.focus.find((item) => item.id === fixture.taskId),
    ).toMatchObject({
      directFollow: false,
      followPriority: 3,
      followReason: "所属工作流已关注",
    });
    await request("POST", "/api/v1/workbench/follows", {
      targetType: "workflow",
      targetId: fixture.workflowId,
      projectId: fixture.project.id,
      followed: false,
    });
    const inheritedFromProject = await request<{
      focus: Array<{
        id: string;
        directFollow: boolean;
        followPriority: number;
        followReason: string;
      }>;
    }>("GET", "/api/v1/workbench/dashboard");
    expect(
      inheritedFromProject.body.focus.find(
        (item) => item.id === fixture.taskId,
      ),
    ).toMatchObject({
      directFollow: false,
      followPriority: 2,
      followReason: "所属项目已关注",
    });
    await request("POST", "/api/v1/workbench/follows", {
      targetType: "project",
      targetId: fixture.project.id,
      projectId: fixture.project.id,
      followed: false,
    });
    const withoutInheritedFocus = await request<{
      focus: Array<{ id: string }>;
    }>("GET", "/api/v1/workbench/dashboard");
    expect(
      withoutInheritedFocus.body.focus.some(
        (item) => item.id === fixture.taskId,
      ),
    ).toBe(false);
  });
});
