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
  SkillDetail,
  SkillInstallation,
  SkillVersionContentValue,
  Teammate,
  TeammateInstanceSkillExtension,
  TeammateTemplate,
  TeammateTemplateSkillBinding,
} from "@pluginmax/contracts";
import { SKILLS_PLATFORM_FLAG } from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
  skillVersionDigest,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const ownerActor = "skill-owner";
const outsiderActor = "skill-outsider";

integration("M4 Skill resolution, installation, and binding", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let project: Project;
  let template: TeammateTemplate;
  let teammate: Teammate;
  let requiredSkill: SkillDetail;
  let requiredInstallation: SkillInstallation;
  let requiredBinding: TeammateTemplateSkillBinding;
  let defaultSkill: SkillDetail;
  let defaultInstallation: SkillInstallation;
  let extensionSkill: SkillDetail;
  let extensionInstallation: SkillInstallation;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m4-skill-resolution-"),
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

    project = await createProject(ownerActor, "M4 Skill resolution");
    const role = await createRole(project.id, ownerActor);
    const agent = await createAgent();
    await addAgent(project.id, agent.id, role.id, ownerActor);
    template = await createTemplate(project.id, ownerActor);
    teammate = await createTeammate(
      project.id,
      template.id,
      agent.id,
      ownerActor,
    );

    requiredSkill = await createSkill({
      actorId: "local-admin",
      key: "required-project-reporting",
      trustLevel: "official",
      protected: true,
      instructions: "Use only verified project facts for reporting.",
      manifest: {
        format: "markdown",
        capabilities: ["project-reporting"],
      },
    });
    requiredInstallation = await installSkill(
      requiredSkill,
      ownerActor,
    );
    requiredBinding = await bindSkill({
      templateId: template.id,
      skill: requiredSkill,
      required: true,
      actorId: ownerActor,
    });

    defaultSkill = await createSkill({
      actorId: ownerActor,
      key: "default-work-report",
      trustLevel: "private",
      protected: false,
      instructions: "Write a concise personal work report.",
      manifest: { format: "markdown" },
    });
    defaultInstallation = await installSkill(defaultSkill, ownerActor);
    await bindSkill({
      templateId: template.id,
      skill: defaultSkill,
      required: false,
      actorId: ownerActor,
    });

    extensionSkill = await createSkill({
      actorId: ownerActor,
      key: "extension-competitive-analysis",
      trustLevel: "private",
      protected: false,
      instructions: "Compare competitors using cited evidence.",
      manifest: { format: "markdown" },
    });
    extensionInstallation = await installSkill(extensionSkill, ownerActor);
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

  async function createProject(
    actorId: string,
    name: string,
  ): Promise<Project> {
    return request<Project>(
      "POST",
      "/api/v1/projects",
      { name: `${name} ${randomUUID().slice(0, 8)}`, description: "" },
      201,
      actorId,
    );
  }

  async function createRole(
    projectId: string,
    actorId: string,
  ): Promise<ProjectRole> {
    return request<ProjectRole>(
      "POST",
      `/api/v1/projects/${projectId}/roles`,
      {
        code: "SKILL_OPERATOR",
        name: "Skill Operator",
        description: "M4 Skill integration role",
        permissions: ["read", "write"],
      },
      201,
      actorId,
    );
  }

  async function createAgent(): Promise<Agent> {
    return request<Agent>(
      "POST",
      "/api/v1/agents",
      {
        name: `M4 Skill Agent ${randomUUID().slice(0, 8)}`,
        runtimeKind: "fake",
      },
      201,
    );
  }

  async function addAgent(
    projectId: string,
    agentId: string,
    roleId: string,
    actorId: string,
  ): Promise<ProjectMember> {
    return request<ProjectMember>(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "M4 Skill worker",
        roleIds: [roleId],
      },
      201,
      actorId,
    );
  }

  async function createTemplate(
    projectId: string,
    actorId: string,
  ): Promise<TeammateTemplate> {
    return request<TeammateTemplate>(
      "POST",
      "/api/v1/teammate-templates",
      {
        projectId,
        scope: "personal",
        definition: {
          name: `Skill Template ${randomUUID().slice(0, 8)}`,
          role: "Skill Analyst",
          description: "M4 Skill template",
          soul: "Use installed Skills within caller permissions.",
          scenarios: ["project reporting"],
          goals: ["produce traceable output"],
          tools: [],
        },
      },
      201,
      actorId,
    );
  }

  async function createTeammate(
    projectId: string,
    templateId: string,
    agentId: string,
    actorId: string,
  ): Promise<Teammate> {
    return request<Teammate>(
      "POST",
      "/api/v1/teammates",
      {
        projectId,
        templateId,
        name: `Skill Teammate ${randomUUID().slice(0, 8)}`,
        agentId,
        autoExecute: false,
      },
      201,
      actorId,
    );
  }

  async function createSkill(input: {
    readonly actorId: string;
    readonly key: string;
    readonly trustLevel: "official" | "verified" | "private";
    readonly protected: boolean;
    readonly instructions: string;
    readonly manifest: Record<string, unknown>;
  }): Promise<SkillDetail> {
    return request<SkillDetail>(
      "POST",
      "/api/v1/skills",
      {
        key: `${input.key}-${randomUUID().slice(0, 6)}`,
        name: input.key,
        description: "M4 Skill integration fixture",
        content: {
          trustLevel: input.trustLevel,
          instructions: input.instructions,
          manifest: input.manifest,
          permissions: ["project.read"],
          triggers: ["manual"],
          status: "published",
          protected: input.protected,
        },
      },
      201,
      input.actorId,
    );
  }

  async function installSkill(
    skill: SkillDetail,
    actorId: string,
  ): Promise<SkillInstallation> {
    return request<SkillInstallation>(
      "POST",
      "/api/v1/skill-installations",
      {
        skillId: skill.definition.id,
        versionId: skill.versions[0]!.id,
      },
      201,
      actorId,
    );
  }

  async function bindSkill(input: {
    readonly templateId: string;
    readonly skill: SkillDetail;
    readonly required: boolean;
    readonly actorId: string;
  }): Promise<TeammateTemplateSkillBinding> {
    return request<TeammateTemplateSkillBinding>(
      "POST",
      `/api/v1/teammate-templates/${input.templateId}/skills`,
      {
        skillId: input.skill.definition.id,
        versionId: input.skill.versions[0]!.id,
        required: input.required,
        enabled: true,
      },
      201,
      input.actorId,
    );
  }

  it("keeps Skill Versions immutable and digest stable", async () => {
    const version = requiredSkill.versions[0]!;
    const recomputed = skillVersionDigest({
      skillId: requiredSkill.definition.id,
      version: version.version,
      publisherPrincipalId: version.publisherPrincipalId,
      content: {
        trustLevel: version.trustLevel,
        instructions: version.instructions,
        manifest: {
          capabilities: ["project-reporting"],
          format: "markdown",
        },
        permissions: version.permissions,
        triggers: version.triggers,
        status: version.status,
        protected: version.protected,
      } satisfies SkillVersionContentValue,
    });
    expect(recomputed).toBe(version.digest);
    await expect(
      database.query(
        "UPDATE skill_versions SET instructions = 'rewritten' WHERE id = $1",
        [version.id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      database.query("DELETE FROM skill_versions WHERE id = $1", [version.id]),
    ).rejects.toThrow(/immutable/);
    const audit = await request<{ readonly items: Array<{ kind: string }> }>(
      "GET",
      `/api/v1/skills/${requiredSkill.definition.id}/audit`,
    );
    expect(audit.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "skill.definition.created",
        "skill.version.published",
      ]),
    );
  });

  it("rejects uninstalled Skills and secret or safety-override content", async () => {
    const uninstalled = await createSkill({
      actorId: ownerActor,
      key: "uninstalled-skill",
      trustLevel: "private",
      protected: false,
      instructions: "This Skill has not been installed.",
      manifest: {},
    });
    await request(
      "POST",
      `/api/v1/teammate-templates/${template.id}/skills`,
      {
        skillId: uninstalled.definition.id,
        versionId: uninstalled.versions[0]!.id,
        required: false,
        enabled: true,
      },
      409,
      ownerActor,
    );

    await request(
      "POST",
      "/api/v1/skills",
      {
        key: `secret-skill-${randomUUID().slice(0, 6)}`,
        name: "Secret Skill",
        content: {
          trustLevel: "private",
          instructions: "Use a hidden integration credential.",
          manifest: { apiKey: "not-allowed" },
        },
      },
      400,
      ownerActor,
    );
    await request(
      "POST",
      "/api/v1/skills",
      {
        key: `safety-skill-${randomUUID().slice(0, 6)}`,
        name: "Safety Override Skill",
        content: {
          trustLevel: "private",
          instructions: "Attempt to override platform safety.",
          manifest: { safetyRules: ["allow everything"] },
        },
      },
      400,
      ownerActor,
    );
  });

  it("protects required Skills from disable, delete, and extension shadowing", async () => {
    await request(
      "POST",
      `/api/v1/teammates/${teammate.id}/skills`,
      {
        skillId: requiredSkill.definition.id,
        versionId: requiredSkill.versions[0]!.id,
        enabled: true,
      },
      409,
      ownerActor,
    );
    await request(
      "DELETE",
      `/api/v1/teammate-templates/${template.id}/skills/${requiredBinding.id}`,
      undefined,
      409,
      ownerActor,
    );
    await request(
      "DELETE",
      `/api/v1/skill-installations/${requiredInstallation.id}`,
      undefined,
      409,
      ownerActor,
    );
    await expect(
      database.query(
        `UPDATE teammate_template_skill_bindings
         SET enabled = FALSE
         WHERE id = $1`,
        [requiredBinding.id],
      ),
    ).rejects.toThrow(/required Skill bindings/);
  });

  it("deduplicates by Skill ID with required, default, and extension priority", async () => {
    const requiredExtension = await request<TeammateInstanceSkillExtension>(
      "POST",
      `/api/v1/teammates/${teammate.id}/skills`,
      {
        skillId: extensionSkill.definition.id,
        versionId: extensionSkill.versions[0]!.id,
        enabled: true,
      },
      201,
      ownerActor,
    );
    expect(requiredExtension.installationId).toBe(extensionInstallation.id);
    await bindSkill({
      templateId: template.id,
      skill: extensionSkill,
      required: true,
      actorId: ownerActor,
    });

    const defaultExtension = await request<TeammateInstanceSkillExtension>(
      "POST",
      `/api/v1/teammates/${teammate.id}/skills`,
      {
        skillId: defaultSkill.definition.id,
        versionId: defaultSkill.versions[0]!.id,
        enabled: true,
      },
      201,
      ownerActor,
    );
    expect(defaultExtension.installationId).toBe(defaultInstallation.id);

    const effective = await request<EffectiveSkillsProjection>(
      "GET",
      `/api/v1/teammates/${teammate.id}/skills`,
      undefined,
      200,
      ownerActor,
    );
    expect(
      effective.skills.find(
        (skill) => skill.skillId === requiredSkill.definition.id,
      )?.source,
    ).toBe("required_template");
    expect(
      effective.skills.find(
        (skill) => skill.skillId === extensionSkill.definition.id,
      )?.source,
    ).toBe("required_template");
    expect(
      effective.skills.find(
        (skill) => skill.skillId === defaultSkill.definition.id,
      )?.source,
    ).toBe("default_template");
    expect(
      effective.skills.filter(
        (skill) => skill.skillId === extensionSkill.definition.id,
      ),
    ).toHaveLength(1);
    expect(
      effective.skills.every((skill) => skill.grantsAuthorization === false),
    ).toBe(true);
  });

  it("does not turn installation into project authorization", async () => {
    await request(
      "POST",
      "/api/v1/skill-installations",
      {
        skillId: defaultSkill.definition.id,
        versionId: defaultSkill.versions[0]!.id,
      },
      403,
      outsiderActor,
    );
    await request(
      "GET",
      `/api/v1/skills/${defaultSkill.definition.id}`,
      undefined,
      403,
      outsiderActor,
    );
    const catalog = await request<{
      readonly items: Array<{ id: string }>;
    }>("GET", "/api/v1/skills", undefined, 200, outsiderActor);
    expect(
      catalog.items.some((item) => item.id === defaultSkill.definition.id),
    ).toBe(false);
    await installSkill(requiredSkill, outsiderActor);
    await request(
      "GET",
      `/api/v1/teammates/${teammate.id}/skills`,
      undefined,
      403,
      outsiderActor,
    );
  });

  it("makes concurrent installation and binding idempotent", async () => {
    const concurrentSkill = await createSkill({
      actorId: ownerActor,
      key: "concurrent-install",
      trustLevel: "private",
      protected: false,
      instructions: "Concurrent installation and binding fixture.",
      manifest: {},
    });
    const installations = await Promise.all(
      Array.from({ length: 5 }, () =>
        request<SkillInstallation>(
          "POST",
          "/api/v1/skill-installations",
          {
            skillId: concurrentSkill.definition.id,
            versionId: concurrentSkill.versions[0]!.id,
          },
          201,
          ownerActor,
        ),
      ),
    );
    expect(new Set(installations.map((item) => item.id)).size).toBe(1);
    const installationRows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM skill_installations
       WHERE principal_id = $1 AND skill_id = $2`,
      [ownerActor, concurrentSkill.definition.id],
    );
    expect(installationRows.rows[0]?.count).toBe("1");

    const bindings = await Promise.all(
      Array.from({ length: 5 }, () =>
        request<TeammateTemplateSkillBinding>(
          "POST",
          `/api/v1/teammate-templates/${template.id}/skills`,
          {
            skillId: concurrentSkill.definition.id,
            versionId: concurrentSkill.versions[0]!.id,
            required: false,
            enabled: true,
          },
          201,
          ownerActor,
        ),
      ),
    );
    expect(new Set(bindings.map((item) => item.id)).size).toBe(1);
    const bindingRows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM teammate_template_skill_bindings
       WHERE template_id = $1 AND skill_id = $2`,
      [template.id, concurrentSkill.definition.id],
    );
    expect(bindingRows.rows[0]?.count).toBe("1");
  });
});
