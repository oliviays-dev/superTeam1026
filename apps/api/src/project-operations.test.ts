import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ProjectAiPmProvisionResult,
  ProjectReportDetail,
  ProjectReportGenerationResult,
  ProjectReportSummary,
  SkillVersionContentValue,
} from "@pluginmax/contracts";
import { skillVersionDigestPayload } from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  migrate,
  PlatformRepositories,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M6 project PM and report PostgreSQL integration", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m6-")),
      logger: process.env.M6_TEST_LOGGER === "1",
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    await app.ready();
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES (
         'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
         1, NOW(), NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    options: {
      readonly actorId?: string;
      readonly idempotencyKey?: string;
    } = {},
  ): Promise<{ statusCode: number; body: T }> {
    const headers: Record<string, string> = {
      "x-pluginmax-actor": options.actorId ?? "local-admin",
    };
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const requestOptions: InjectOptions = { method, url, headers };
    if (payload !== undefined) {
      requestOptions.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(requestOptions);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function setFlag(flagKey: string, mode: "on" | "off"): Promise<void> {
    await database.query(
      `UPDATE feature_flag_settings
       SET mode = $2, revision = revision + 1, updated_at = NOW()
       WHERE flag_key = $1
         AND scope_type = 'platform'
         AND scope_id = 'platform'`,
      [flagKey, mode],
    );
  }

  async function createProject(): Promise<string> {
    const response = await request<{ id: string }>(
      "POST",
      "/api/v1/projects",
      {
        name: `M6 Project ${randomUUID().slice(0, 8)}`,
        description: "M6 project operations",
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body.id;
  }

  async function addTaskFact(
    projectId: string,
    title = `M6 task ${randomUUID().slice(0, 8)}`,
  ): Promise<string> {
    const taskId = randomUUID();
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status, agent_id,
         priority, auto_submit, auto_accept, auto_redispatch_on_return,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'M6 report fact', '["fact is traceable"]'::jsonb,
         'done', '00000000-0000-4000-8000-000000000001', 'medium',
         TRUE, FALSE, FALSE, NOW(), NOW()
       )`,
      [taskId, projectId, title],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         observability, created_at, updated_at
       ) VALUES (
         $1, $2, $3, '00000000-0000-4000-8000-000000000001',
         'completed', '{}'::jsonb, '{}'::jsonb, NOW(), NOW()
       )`,
      [randomUUID(), projectId, taskId],
    );
    return taskId;
  }

  async function addWorkflowFact(projectId: string): Promise<void> {
    const workflowId = randomUUID();
    await database.query(
      `INSERT INTO workflow_definitions (
         id, project_id, name, description, steps, source_md, graph, status,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'M6 Workflow', '', '[]'::jsonb, '', NULL, 'active',
         NOW(), NOW()
       )`,
      [workflowId, projectId],
    );
    await database.query(
      `INSERT INTO workflow_instances (
         id, workflow_id, project_id, title, status, current_step, steps,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'M6 Workflow', 'active', 0, '[]'::jsonb,
         NOW(), NOW()
       )`,
      [randomUUID(), workflowId, projectId],
    );
  }

  async function generate(
    projectId: string,
    input: Record<string, unknown>,
    idempotencyKey = `report-${randomUUID()}`,
  ): Promise<{ statusCode: number; body: ProjectReportGenerationResult }> {
    return request<ProjectReportGenerationResult>(
      "POST",
      `/api/v1/projects/${projectId}/reports/generate`,
      input,
      { idempotencyKey },
    );
  }

  it("keeps project AI PM off by default", async () => {
    await setFlag("project.ai_pm", "off");
    const projectId = await createProject();
    const result = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM project_ai_pms WHERE project_id = $1",
      [projectId],
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("does not let Project PM expand member management permissions", async () => {
    await setFlag("skills.platform", "on");
    await setFlag("project.ai_pm", "on");
    const projectId = await createProject();
    const manager = await repositories.projectAiPms.get(projectId);
    expect(manager?.status).toBe("ready");
    expect(manager?.agentPrincipalId).toBeTruthy();
    const role = await database.query<{ permissions: string[] }>(
      "SELECT permissions FROM project_roles WHERE id = $1",
      [manager!.roleId],
    );
    expect([...role.rows[0]!.permissions].sort()).toEqual(["read", "write"]);
    const capability =
      await repositories.authorization.getProjectCapability({
        principalId: manager!.agentPrincipalId!,
        authSource: "bearer",
        projectId,
      });
    expect(capability.capability?.capabilities).toMatchObject({
      read: true,
      write: true,
      approve: false,
      manage_members: false,
      manage_roles: false,
    });
    const template = await database.query<{
      protected: boolean;
      scope: string;
    }>("SELECT protected, scope FROM teammate_templates WHERE id = $1", [
      manager!.templateId,
    ]);
    expect(template.rows[0]).toEqual({ protected: true, scope: "personal" });
  });

  it("serializes concurrent AI PM initialization to one instance", async () => {
    await setFlag("skills.platform", "on");
    await setFlag("project.ai_pm", "off");
    const projectId = await createProject();
    await setFlag("project.ai_pm", "on");
    const [first, second] = await Promise.all([
      request<ProjectAiPmProvisionResult>(
        "POST",
        `/api/v1/projects/${projectId}/ai-pm`,
        {},
        { idempotencyKey: randomUUID() },
      ),
      request<ProjectAiPmProvisionResult>(
        "POST",
        `/api/v1/projects/${projectId}/ai-pm`,
        {},
        { idempotencyKey: randomUUID() },
      ),
    ]);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(second.statusCode, JSON.stringify(second.body)).toBe(200);
    const counts = await database.query<{
      managers: string;
      teammates: string;
      agents: string;
      principals: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM project_ai_pms WHERE project_id = $1)
           AS managers,
         (SELECT COUNT(*)::text FROM teammates WHERE project_id = $1)
           AS teammates,
         (SELECT COUNT(*)::text FROM agents
          WHERE id IN (
            SELECT agent_id FROM project_ai_pms WHERE project_id = $1
          )) AS agents,
         (SELECT COUNT(DISTINCT agent_principal_id)::text FROM project_ai_pms
          WHERE project_id = $1) AS principals`,
      [projectId],
    );
    expect(counts.rows[0]).toEqual({
      managers: "1",
      teammates: "1",
      agents: "1",
      principals: "1",
    });
  });

  it("keeps AI PM failure retryable without failing Project creation", async () => {
    await setFlag("project.ai_pm", "on");
    await setFlag("skills.platform", "off");
    const projectId = await createProject();
    const failed = await repositories.projectAiPms.get(projectId);
    expect(failed?.status).toBe("failed");
    const audit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE action = 'project.manager.provision_failed'
         AND metadata ->> 'projectId' = $1`,
      [projectId],
    );
    expect(audit.rows[0]?.count).toBe("1");
    await setFlag("skills.platform", "on");
    const retried = await request<ProjectAiPmProvisionResult>(
      "POST",
      `/api/v1/projects/${projectId}/ai-pm`,
      {},
      { idempotencyKey: randomUUID() },
    );
    expect(retried.statusCode, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.manager.status).toBe("ready");
  });

  it("keeps daily, weekly and progress reports together with source cutoffs and Run/Skill traceability", async () => {
    await setFlag("skills.platform", "on");
    await setFlag("project.ai_pm", "on");
    const projectId = await createProject();
    await addTaskFact(projectId);
    await addWorkflowFact(projectId);
    const reportDate = "2026-11-13";
    const reports: ProjectReportDetail[] = [];
    for (const [index, reportKind] of (
      ["daily", "weekly", "progress"] as const
    ).entries()) {
      const generated = await generate(
        projectId,
        {
          reportDate,
          reportKind,
          ...(reportKind === "progress"
            ? {
                periodStart: "2026-11-01T00:00:00+08:00",
                periodEnd: "2026-11-14T00:00:00+08:00",
              }
            : {}),
          triggerSource: "api",
        },
        `m6-kinds-${index}-${randomUUID()}`,
      );
      expect(generated.statusCode, JSON.stringify(generated.body)).toBe(200);
      reports.push(generated.body.report);
    }
    expect(reports.map((report) => report.reportKind)).toEqual([
      "daily",
      "weekly",
      "progress",
    ]);
    for (const report of reports) {
      expect(report.runId).toBeTruthy();
      expect(report.skillVersion).toBe(1);
      expect(report.skillDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(report.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(report.sourceCutoffAt).toBeTruthy();
      expect(report.snapshot.facts).toBeDefined();
      expect(report.snapshot.facts?.cutoffAt).toBe(report.sourceCutoffAt);
      expect(report.snapshot.facts?.tasks.length).toBeGreaterThan(0);
      expect(report.snapshot.facts?.workflows.length).toBeGreaterThan(0);
      expect(report.snapshot.facts?.sourceRefs.length).toBeGreaterThan(0);
      expect(
        report.snapshot.facts?.sourceRefs.every(
          (source) => source.cutoffAt === report.sourceCutoffAt,
        ),
      ).toBe(true);
      const runSnapshot = await repositories.skills.getRunSnapshot(
        report.runId!,
      );
      expect(
        runSnapshot?.skills.some(
          (skill) =>
            skill.key === "project-reporting" &&
            skill.version === report.skillVersion,
        ),
      ).toBe(true);
    }
    const list = await request<{ items: ProjectReportSummary[] }>(
      "GET",
      `/api/v1/projects/${projectId}/reports?reportKind=daily`,
      undefined,
    );
    expect(list.statusCode).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]?.reportKind).toBe("daily");
  });

  it("creates only one report version under concurrent generation", async () => {
    await setFlag("skills.platform", "on");
    await setFlag("project.ai_pm", "on");
    const projectId = await createProject();
    await addTaskFact(projectId);
    const payload = {
      reportDate: "2026-11-12",
      reportKind: "daily",
      triggerSource: "api",
    };
    const [first, second] = await Promise.all([
      generate(projectId, payload, `concurrent-a-${randomUUID()}`),
      generate(projectId, payload, `concurrent-b-${randomUUID()}`),
    ]);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(second.statusCode, JSON.stringify(second.body)).toBe(200);
    expect([first.body.created, second.body.created].sort()).toEqual([
      false,
      true,
    ]);
    expect(first.body.report.id).toBe(second.body.report.id);
    const count = await database.query<{ count: string; version: number }>(
      `SELECT COUNT(*)::text AS count, MAX(version) AS version
       FROM project_reports
       WHERE project_id = $1
         AND report_date = $2
         AND report_kind = 'daily'`,
      [projectId, payload.reportDate],
    );
    expect(count.rows[0]).toEqual({ count: "1", version: 1 });
  });

  it("does not rewrite historical reports after the Project Reporting Skill upgrades", async () => {
    await setFlag("skills.platform", "on");
    await setFlag("project.ai_pm", "on");
    const projectId = await createProject();
    await addTaskFact(projectId, "Skill v1 report task");
    const first = await generate(projectId, {
      reportDate: "2026-11-11",
      reportKind: "daily",
      triggerSource: "api",
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(first.body.report.skillVersion).toBe(1);
    const manager = (await repositories.projectAiPms.get(projectId))!;
    const content: SkillVersionContentValue = {
      trustLevel: "official",
      instructions:
        "Project Reporting v2: preserve every source cutoff and never rewrite history.",
      manifest: {
        output: "project-report",
        reportKinds: ["daily", "weekly", "progress"],
        versionLabel: "v2",
      },
      permissions: [],
      triggers: ["project-report"],
      status: "published",
      protected: true,
    };
    const versionId = randomUUID();
    const digest = createHash("sha256")
      .update(
        skillVersionDigestPayload({
          skillId: manager.skillId!,
          version: 2,
          publisherPrincipalId: "local-admin",
          trustLevel: content.trustLevel,
          instructions: content.instructions,
          manifest: content.manifest,
          permissions: content.permissions,
          triggers: content.triggers,
          status: content.status,
          protected: content.protected,
        }),
      )
      .digest("hex");
    await database.query(
      `INSERT INTO skill_versions (
         id, skill_id, version, digest, publisher_principal_id,
         trust_level, instructions, manifest, permissions, triggers,
         status, protected, created_at
       ) VALUES (
         $1, $2, 2, $3, 'local-admin', $4, $5, $6::jsonb, $7::jsonb,
         $8::jsonb, $9, $10, NOW()
       )`,
      [
        versionId,
        manager.skillId,
        digest,
        content.trustLevel,
        content.instructions,
        JSON.stringify(content.manifest),
        JSON.stringify(content.permissions),
        JSON.stringify(content.triggers),
        content.status,
        content.protected,
      ],
    );
    await database.query(
      "UPDATE skill_definitions SET current_version = 2, updated_at = NOW() WHERE id = $1",
      [manager.skillId],
    );
    await database.query(
      "UPDATE skill_installations SET version_id = $2, revision = revision + 1, updated_at = NOW() WHERE id = $1",
      [manager.skillInstallationId, versionId],
    );
    await database.query(
      "UPDATE teammate_template_skill_bindings SET skill_version_id = $2, updated_at = NOW() WHERE id = $1",
      [manager.skillBindingId, versionId],
    );
    await addTaskFact(projectId, "Skill v2 report task");
    const second = await generate(
      projectId,
      {
        reportDate: "2026-11-11",
        reportKind: "daily",
        triggerSource: "api",
      },
      `skill-v2-${randomUUID()}`,
    );
    expect(second.statusCode, JSON.stringify(second.body)).toBe(200);
    expect(second.body.report.skillVersion).toBe(2);
    expect(second.body.report.version).toBe(2);
    const historical = await request<ProjectReportDetail>(
      "GET",
      `/api/v1/projects/${projectId}/reports/${first.body.report.id}`,
    );
    expect(historical.statusCode).toBe(200);
    expect(historical.body.skillVersion).toBe(1);
    expect(historical.body.skillDigest).toBe(first.body.report.skillDigest);
    await expect(
      database.query(
        "UPDATE project_reports SET snapshot = '{}'::jsonb WHERE id = $1",
        [first.body.report.id],
      ),
    ).rejects.toThrow("project reports are immutable");
  });
});
