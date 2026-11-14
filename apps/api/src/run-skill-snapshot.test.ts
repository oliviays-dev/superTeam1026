import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Agent,
  EffectiveSkillsProjection,
  Project,
  ProjectMember,
  ProjectRole,
  RunSkillSnapshot,
  SkillDetail,
  SkillInstallation,
  Teammate,
  TeammateTemplate,
  TeammateTemplateSkillBinding,
} from "@pluginmax/contracts";
import { SKILLS_PLATFORM_FLAG } from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M4 Run Skill Snapshot", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let project: Project;
  let template: TeammateTemplate;
  let teammate: Teammate;
  let skill: SkillDetail;
  let v1Installation: SkillInstallation;
  let v1Binding: TeammateTemplateSkillBinding;
  let firstSnapshot: RunSkillSnapshot;
  let firstRunId: string;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m4-run-snapshot-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    await app.ready();
    await repositories.featureFlags.set({
      flagKey: SKILLS_PLATFORM_FLAG,
      scopeType: "platform",
      scopeId: "platform",
      mode: "on",
      updatedBy: "local-admin",
    });

    project = await request<Project>(
      "POST",
      "/api/v1/projects",
      { name: `M4 Run Snapshot ${randomUUID().slice(0, 8)}` },
      201,
    );
    const role = await request<ProjectRole>(
      "POST",
      `/api/v1/projects/${project.id}/roles`,
      {
        code: "SNAPSHOT_OPERATOR",
        name: "Snapshot Operator",
        description: "M4 Run Snapshot role",
        permissions: ["read", "write"],
      },
      201,
    );
    const agent = await request<Agent>(
      "POST",
      "/api/v1/agents",
      {
        name: `M4 Snapshot Agent ${randomUUID().slice(0, 8)}`,
        runtimeKind: "fake",
      },
      201,
    );
    await request<ProjectMember>(
      "POST",
      `/api/v1/projects/${project.id}/members`,
      {
        kind: "agent",
        agentId: agent.id,
        responsibility: "M4 Run Snapshot worker",
        roleIds: [role.id],
      },
      201,
    );
    template = await request<TeammateTemplate>(
      "POST",
      "/api/v1/teammate-templates",
      {
        projectId: project.id,
        scope: "personal",
        definition: {
          name: `Snapshot Template ${randomUUID().slice(0, 8)}`,
          role: "Snapshot Analyst",
          description: "M4 Run Snapshot template",
          soul: "Use immutable Run Skills.",
          scenarios: ["reporting"],
          goals: ["preserve history"],
          tools: [],
        },
      },
      201,
    );
    teammate = await request<Teammate>(
      "POST",
      "/api/v1/teammates",
      {
        projectId: project.id,
        templateId: template.id,
        name: `Snapshot Teammate ${randomUUID().slice(0, 8)}`,
        agentId: agent.id,
        autoExecute: false,
      },
      201,
    );
    skill = await request<SkillDetail>(
      "POST",
      "/api/v1/skills",
      {
        key: `run-snapshot-${randomUUID().slice(0, 6)}`,
        name: "Run Snapshot Skill",
        description: "M4 Run Snapshot fixture",
        content: {
          trustLevel: "private",
          instructions: "Version one instructions.",
          manifest: {
            versionFixture: 1,
            capability: "snapshot",
          },
          permissions: ["project.read"],
          triggers: ["task.dispatch"],
          status: "published",
          protected: false,
        },
      },
      201,
    );
    v1Installation = await installVersion(skill, 0);
    v1Binding = await bindVersion(skill, 0, false);

    firstRunId = await createWorkPlanAndDispatchRun();
    firstSnapshot = await request<RunSkillSnapshot>(
      "GET",
      `/api/v1/runs/${firstRunId}/skills`,
    );
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    expectedStatus?: number,
    actorId = "local-admin",
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
    if (expectedStatus !== undefined) {
      expect(response.statusCode, JSON.stringify(body)).toBe(expectedStatus);
    } else {
      expect(
        response.statusCode,
        `${method} ${url}: ${JSON.stringify(body)}`,
      ).toBeLessThan(400);
    }
    return body as T;
  }

  async function installVersion(
    detail: SkillDetail,
    versionIndex: number,
  ): Promise<SkillInstallation> {
    return request<SkillInstallation>(
      "POST",
      "/api/v1/skill-installations",
      {
        skillId: detail.definition.id,
        versionId: detail.versions[versionIndex]!.id,
      },
      201,
    );
  }

  async function bindVersion(
    detail: SkillDetail,
    versionIndex: number,
    required: boolean,
  ): Promise<TeammateTemplateSkillBinding> {
    return request<TeammateTemplateSkillBinding>(
      "POST",
      `/api/v1/teammate-templates/${template.id}/skills`,
      {
        skillId: detail.definition.id,
        versionId: detail.versions[versionIndex]!.id,
        required,
        enabled: true,
      },
      201,
    );
  }

  async function createWorkPlanAndDispatchRun(): Promise<string> {
    const plan = await request<{ readonly taskIds: string[] }>(
      "POST",
      `/api/v1/teammates/${teammate.id}/work-plans`,
      {
        instruction: "Produce a snapshot verification report.",
        items: [
          {
            title: `Snapshot task ${randomUUID().slice(0, 8)}`,
            description: "Create a report with immutable Skill instructions.",
            acceptance: ["Report uses the Run Skill Snapshot"],
            priority: "medium",
          },
        ],
        autoExecuteEligible: false,
      },
      201,
    );
    const taskId = plan.taskIds[0]!;
    const dispatch = await request<{ readonly runId: string }>(
      "POST",
      `/api/v1/tasks/${taskId}/dispatch`,
      {},
      202,
    );
    return dispatch.runId;
  }

  it("captures Effective Skills in the Run creation transaction", () => {
    expect(firstSnapshot.runId).toBe(firstRunId);
    expect(firstSnapshot.teammateId).toBe(teammate.id);
    expect(firstSnapshot.templateId).toBe(template.id);
    expect(firstSnapshot.skills).toHaveLength(1);
    expect(firstSnapshot.skills[0]).toMatchObject({
      skillId: skill.definition.id,
      version: 1,
      instructions: "Version one instructions.",
      source: "default_template",
      grantsAuthorization: false,
    });
    expect(firstSnapshot.platformSafetyRules.map((rule) => rule.code)).toEqual(
      ["skill.no_secret", "skill.no_authorization", "skill.append_only"],
    );
  });

  it("does not rewrite historical Runs when a Skill version is upgraded", async () => {
    const upgraded = await request<SkillDetail>(
      "POST",
      `/api/v1/skills/${skill.definition.id}/versions`,
      {
        expectedCurrentVersion: 1,
        content: {
          trustLevel: "private",
          instructions: "Version two instructions.",
          manifest: {
            versionFixture: 2,
            capability: "snapshot",
          },
          permissions: ["project.read"],
          triggers: ["task.dispatch"],
          status: "published",
          protected: false,
        },
      },
      201,
    );
    expect(upgraded.versions[0]!.version).toBe(2);
    const v2Installation = await installVersion(upgraded, 0);
    expect(v2Installation.id).toBe(v1Installation.id);
    await request(
      "DELETE",
      `/api/v1/teammate-templates/${template.id}/skills/${v1Binding.id}`,
      undefined,
      204,
    );
    await bindVersion(upgraded, 0, false);

    const effective = await request<EffectiveSkillsProjection>(
      "GET",
      `/api/v1/teammates/${teammate.id}/skills`,
    );
    expect(effective.skills[0]).toMatchObject({
      skillId: skill.definition.id,
      version: 2,
      instructions: "Version two instructions.",
    });

    const secondRunId = await createWorkPlanAndDispatchRun();
    const secondSnapshot = await request<RunSkillSnapshot>(
      "GET",
      `/api/v1/runs/${secondRunId}/skills`,
    );
    expect(secondSnapshot.skills[0]).toMatchObject({
      skillId: skill.definition.id,
      version: 2,
      instructions: "Version two instructions.",
    });
    expect(secondSnapshot.snapshotDigest).not.toBe(
      firstSnapshot.snapshotDigest,
    );

    const historical = await request<RunSkillSnapshot>(
      "GET",
      `/api/v1/runs/${firstRunId}/skills`,
    );
    expect(historical).toEqual(firstSnapshot);
    expect(historical.skills[0]).toMatchObject({
      version: 1,
      instructions: "Version one instructions.",
    });
  });

  it("makes Run Skill Snapshots immutable at the database boundary", async () => {
    await expect(
      database.query(
        `UPDATE run_skill_snapshots
         SET skills = '[]'::jsonb
         WHERE run_id = $1`,
        [firstRunId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      database.query("DELETE FROM run_skill_snapshots WHERE run_id = $1", [
        firstRunId,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});
