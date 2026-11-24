import { createHash, randomUUID } from "node:crypto";
import type {
  ProjectAiPm,
  ProjectAiPmProvisionResult,
  ProvisionProjectAiPmInput,
  TeammateDefinition,
} from "@pluginmax/contracts";
import {
  PROJECT_AI_PM_FLAG,
  SKILLS_PLATFORM_FLAG,
  skillVersionDigestPayload,
  teammateDefinitionSchema,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { AuthorizationRepository } from "./authorization-repository.js";
import { appendAuditEventWithClient } from "./audit-event-repository.js";
import type { Database } from "./database.js";

interface ProjectAiPmRow {
  project_id: string;
  status: ProjectAiPm["status"];
  role_id: string | null;
  member_id: string | null;
  agent_id: string | null;
  agent_principal_id: string | null;
  teammate_id: string | null;
  template_id: string | null;
  template_version_id: string | null;
  skill_id: string | null;
  skill_version_id: string | null;
  skill_installation_id: string | null;
  skill_binding_id: string | null;
  runtime_profile_id: string | null;
  runtime_profile_kind: ProjectAiPm["runtimeProfileKind"];
  last_error: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface ProjectRow {
  id: string;
  name: string;
  code: string;
  status: "active" | "archived";
}

interface ProjectRoleRow {
  id: string;
  permissions: string[];
}

interface SkillRow {
  id: string;
  current_version: number;
}

interface SkillVersionRow {
  id: string;
  version: number;
  digest: string;
}

interface TemplateRow {
  id: string;
  current_version: number;
}

interface TemplateVersionRow {
  id: string;
  version: number;
}

interface ProjectPmTemplateDescriptor {
  readonly id: string;
  readonly versionId: string;
  readonly version: number;
}

interface ProjectReportingSkillDescriptor {
  readonly skillId: string;
  readonly versionId: string;
  readonly version: number;
  readonly digest: string;
}

interface AgentRow {
  id: string;
}

interface TeammateRow {
  id: string;
}

interface InstallationRow {
  id: string;
}

interface BindingRow {
  id: string;
}

interface MemberRow {
  id: string;
}

const PROJECT_PM_ROLE_CODE = "PROJECT_PM";
const PROJECT_REPORTING_SKILL_KEY = "project-reporting";

const PROJECT_PM_TEMPLATE: TeammateDefinition = teammateDefinitionSchema.parse({
  name: "Project PM",
  role: "项目运营与汇报",
  description:
    "受保护的项目 AI PM，仅负责基于项目事实进行日报、周报和进度汇报。",
  soul:
    "你是项目 AI PM。只使用事实包和授权工具，不编造负责人、日期、数字或结论，不代签审批，不扩大项目权限。",
  scenarios: ["daily-report", "weekly-report", "progress-report"],
  goals: [
    "汇总项目状态、进度、任务、Workflow、交付物与风险",
    "为每个结论保留 source refs 和事实 cutoff",
  ],
  tools: [
    "entity.read",
    "task.runs",
    "workflow.read",
    "report.write",
  ],
});

export class ProjectAiPmRepositoryError extends Error {
  constructor(
    readonly code:
      | "project_ai_pm_disabled"
      | "project_ai_pm_dependency_disabled"
      | "project_ai_pm_project_invalid"
      | "project_ai_pm_actor_invalid"
      | "project_ai_pm_role_unsafe"
      | "project_ai_pm_runtime_invalid"
      | "project_ai_pm_provision_failed",
    message: string,
  ) {
    super(message);
    this.name = "ProjectAiPmRepositoryError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function managerFromRow(row: ProjectAiPmRow): ProjectAiPm {
  return {
    projectId: row.project_id,
    status: row.status,
    roleId: row.role_id,
    memberId: row.member_id,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    teammateId: row.teammate_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    skillInstallationId: row.skill_installation_id,
    skillBindingId: row.skill_binding_id,
    runtimeProfileId: row.runtime_profile_id,
    runtimeProfileKind: row.runtime_profile_kind,
    lastError: row.last_error,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4_000);
  return "Project AI PM provisioning failed".slice(0, 4_000);
}

async function featureEnabled(
  client: PoolClient,
  flagKey: string,
  projectId: string,
): Promise<boolean> {
  const result = await client.query<{ mode: string }>(
    `SELECT mode
     FROM feature_flag_settings
     WHERE flag_key = $1
       AND (
         (scope_type = 'project' AND scope_id = $2)
         OR (scope_type = 'platform' AND scope_id = 'platform')
       )
     ORDER BY CASE scope_type WHEN 'project' THEN 0 ELSE 1 END
     LIMIT 1`,
    [flagKey, projectId],
  );
  return ["on", "enforce"].includes(result.rows[0]?.mode ?? "off");
}

export class ProjectAiPmRepository {
  constructor(
    private readonly database: Database,
    private readonly authorization: AuthorizationRepository,
  ) {}

  async get(projectId: string): Promise<ProjectAiPm | undefined> {
    const result = await this.database.query<ProjectAiPmRow>(
      "SELECT * FROM project_ai_pms WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : managerFromRow(row);
  }

  async provision(input: {
    readonly projectId: string;
    readonly actorPrincipalId: string;
    readonly value?: ProvisionProjectAiPmInput;
  }): Promise<ProjectAiPmProvisionResult> {
    try {
      return await this.database.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`project-ai-pm:${input.projectId}`],
        );
        if (
          !(await featureEnabled(
            client,
            PROJECT_AI_PM_FLAG,
            input.projectId,
          ))
        ) {
          throw new ProjectAiPmRepositoryError(
            "project_ai_pm_disabled",
            "Project AI PM is disabled",
          );
        }
        if (
          !(await featureEnabled(
            client,
            SKILLS_PLATFORM_FLAG,
            input.projectId,
          ))
        ) {
          throw new ProjectAiPmRepositoryError(
            "project_ai_pm_dependency_disabled",
            "The Skill platform must be enabled before provisioning AI PM",
          );
        }

        const projectResult = await client.query<ProjectRow>(
          `SELECT id, name, code, status
           FROM projects
           WHERE id = $1
           FOR UPDATE`,
          [input.projectId],
        );
        const project = projectResult.rows[0];
        if (project === undefined || project.status !== "active") {
          throw new ProjectAiPmRepositoryError(
            "project_ai_pm_project_invalid",
            "An active Project is required",
          );
        }

        const actor = await client.query<{
          id: string;
          display_name: string;
          kind: string;
          status: string;
        }>(
          `SELECT id, display_name, kind, status
           FROM principals
           WHERE id = $1`,
          [input.actorPrincipalId],
        );
        const actorRow = actor.rows[0];
        if (
          actorRow === undefined ||
          actorRow.kind !== "human" ||
          actorRow.status !== "active"
        ) {
          throw new ProjectAiPmRepositoryError(
            "project_ai_pm_actor_invalid",
            "An active human Principal is required",
          );
        }

        const existingResult = await client.query<ProjectAiPmRow>(
          "SELECT * FROM project_ai_pms WHERE project_id = $1 FOR UPDATE",
          [input.projectId],
        );
        const existing = existingResult.rows[0];
        if (existing?.status === "ready") {
          return {
            manager: managerFromRow(existing),
            created: false,
            reused: true,
          };
        }

        const role = await this.ensureProjectPmRole(client, project.id);
        const skill = await this.ensureProjectReportingSkill(
          client,
          input.actorPrincipalId,
        );
        const template = await this.ensureProjectPmTemplate(
          client,
          project,
          input.actorPrincipalId,
        );
        const runtime = await this.ensureRuntimeProfile(
          client,
          project.id,
          input.actorPrincipalId,
          input.value?.runtimeProfileId,
        );
        const agentPrincipal = await this.ensureAgentPrincipal(
          client,
          project.id,
        );
        const agent = await this.ensureAgent(
          client,
          project,
          input.actorPrincipalId,
          agentPrincipal,
          runtime.agentRuntimeKind,
        );
        await this.ensureRuntimeBinding(
          client,
          agent.id,
          input.actorPrincipalId,
          runtime.externalRuntimeId,
        );
        const teammate = await this.ensureTeammate(
          client,
          project,
          input.actorPrincipalId,
          template,
          agent.id,
          agentPrincipal,
        );
        const member = await this.ensureProjectMember(
          client,
          project.id,
          input.actorPrincipalId,
          agent.id,
          agentPrincipal,
          role.id,
        );
        const installation = await this.ensureSkillInstallation(
          client,
          input.actorPrincipalId,
          skill,
        );
        const binding = await this.ensureSkillBinding(
          client,
          template,
          input.actorPrincipalId,
          skill,
          installation.id,
        );

        const saved = await client.query<ProjectAiPmRow>(
          `INSERT INTO project_ai_pms (
             project_id, status, role_id, member_id, agent_id,
             agent_principal_id, teammate_id, template_id,
             template_version_id, skill_id, skill_version_id,
             skill_installation_id, skill_binding_id,
             runtime_profile_id, runtime_profile_kind, last_error,
             revision, created_at, updated_at
           ) VALUES (
             $1, 'ready', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, NULL, 1, NOW(), NOW()
           )
           ON CONFLICT (project_id) DO UPDATE
           SET
             status = 'ready',
             role_id = EXCLUDED.role_id,
             member_id = EXCLUDED.member_id,
             agent_id = EXCLUDED.agent_id,
             agent_principal_id = EXCLUDED.agent_principal_id,
             teammate_id = EXCLUDED.teammate_id,
             template_id = EXCLUDED.template_id,
             template_version_id = EXCLUDED.template_version_id,
             skill_id = EXCLUDED.skill_id,
             skill_version_id = EXCLUDED.skill_version_id,
             skill_installation_id = EXCLUDED.skill_installation_id,
             skill_binding_id = EXCLUDED.skill_binding_id,
             runtime_profile_id = EXCLUDED.runtime_profile_id,
             runtime_profile_kind = EXCLUDED.runtime_profile_kind,
             last_error = NULL,
             revision = project_ai_pms.revision + 1,
             updated_at = NOW()
           RETURNING *`,
          [
            project.id,
            role.id,
            member.id,
            agent.id,
            agentPrincipal,
            teammate.id,
            template.id,
            template.versionId,
            skill.skillId,
            skill.versionId,
            installation.id,
            binding.id,
            runtime.runtimeProfileId,
            runtime.runtimeProfileKind,
          ],
        );
        await appendAuditEventWithClient(client, {
          action: "project.manager.provisioned",
          actorPrincipalId: input.actorPrincipalId,
          subjectPrincipalId: agentPrincipal,
          metadata: {
            projectId: project.id,
            roleId: role.id,
            memberId: member.id,
            agentId: agent.id,
            teammateId: teammate.id,
            templateId: template.id,
            templateVersionId: template.versionId,
            skillId: skill.skillId,
            skillVersionId: skill.versionId,
            skillVersion: skill.version,
            skillDigest: skill.digest,
            runtimeProfileId: runtime.runtimeProfileId,
            runtimeProfileKind: runtime.runtimeProfileKind,
            idempotencyKey: `project-ai-pm:${project.id}`,
          },
        });
        return {
          manager: managerFromRow(saved.rows[0]!),
          created: existing === undefined,
          reused: false,
        };
      });
    } catch (error) {
      if (
        !(
          error instanceof ProjectAiPmRepositoryError &&
          error.code === "project_ai_pm_disabled"
        )
      ) {
        await this.recordFailure({
          projectId: input.projectId,
          actorPrincipalId: input.actorPrincipalId,
          error,
        });
      }
      throw error;
    }
  }

  private async recordFailure(input: {
    readonly projectId: string;
    readonly actorPrincipalId: string;
    readonly error: unknown;
  }): Promise<void> {
    const message = errorMessage(input.error);
    try {
      await this.database.transaction(async (client) => {
        await client.query(
          `INSERT INTO project_ai_pms (
             project_id, status, runtime_profile_kind, last_error,
             revision, created_at, updated_at
           ) VALUES ($1, 'failed', 'builtin', $2, 1, NOW(), NOW())
           ON CONFLICT (project_id) DO UPDATE
           SET
             status = CASE
               WHEN project_ai_pms.status = 'ready' THEN 'ready'
               ELSE 'failed'
             END,
             last_error = CASE
               WHEN project_ai_pms.status = 'ready' THEN NULL
               ELSE EXCLUDED.last_error
             END,
             revision = project_ai_pms.revision + 1,
             updated_at = NOW()`,
          [input.projectId, message],
        );
        await appendAuditEventWithClient(client, {
          action: "project.manager.provision_failed",
          actorPrincipalId: input.actorPrincipalId,
          reason: message,
          metadata: {
            projectId: input.projectId,
            idempotencyKey: `project-ai-pm:${input.projectId}`,
            retryable: true,
            error:
              input.error instanceof ProjectAiPmRepositoryError
                ? input.error.code
                : "project_ai_pm_provision_failed",
          },
        });
      });
    } catch {
      // Failure state is best-effort and must not replace the provisioning error.
    }
  }

  private async ensureProjectPmRole(
    client: PoolClient,
    projectId: string,
  ): Promise<ProjectRoleRow> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`project-pm-role:${projectId}`],
    );
    const existing = await client.query<ProjectRoleRow>(
      `SELECT id, permissions
       FROM project_roles
       WHERE project_id = $1 AND lower(code) = lower($2)`,
      [projectId, PROJECT_PM_ROLE_CODE],
    );
    const role = existing.rows[0];
    if (role !== undefined) {
      const permissions = [...new Set(role.permissions)].sort();
      if (
        permissions.length !== 2 ||
        permissions[0] !== "read" ||
        permissions[1] !== "write"
      ) {
        throw new ProjectAiPmRepositoryError(
          "project_ai_pm_role_unsafe",
          "The Project PM role must only contain read and write permissions",
        );
      }
      return role;
    }
    const inserted = await client.query<ProjectRoleRow>(
      `INSERT INTO project_roles (
         id, project_id, code, name, category, description, permissions,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, '项目 PM', 'execution',
         '项目运营与汇报，不授予成员或角色管理权限。',
         '["read","write"]'::jsonb, NOW(), NOW()
       )
       RETURNING id, permissions`,
      [randomUUID(), projectId, PROJECT_PM_ROLE_CODE],
    );
    return inserted.rows[0]!;
  }

  private async ensureProjectReportingSkill(
    client: PoolClient,
    actorPrincipalId: string,
  ): Promise<ProjectReportingSkillDescriptor> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`skill-definition:${PROJECT_REPORTING_SKILL_KEY}`],
    );
    let definition = (
      await client.query<SkillRow>(
        "SELECT id, current_version FROM skill_definitions WHERE key = $1",
        [PROJECT_REPORTING_SKILL_KEY],
      )
    ).rows[0];
    if (definition === undefined) {
      const skillId = randomUUID();
      const content = {
        trustLevel: "official" as const,
        instructions:
          "基于项目事实包生成日报、周报或进度报告。只引用事实包中的项目状态、进度、任务、Workflow、交付物、风险和 source refs；保留事实 cutoff；不得编造数据、代签审批或扩大权限。",
        manifest: {
          output: "project-report",
          reportKinds: ["daily", "weekly", "progress"],
          requiresFactCutoff: true,
          requiresSourceRefs: true,
        },
        permissions: [],
        triggers: ["project-report"],
        status: "published" as const,
        protected: true,
      };
      const digest = sha256(
        skillVersionDigestPayload({
          skillId,
          version: 1,
          publisherPrincipalId: actorPrincipalId,
          trustLevel: content.trustLevel,
          instructions: content.instructions,
          manifest: content.manifest,
          permissions: content.permissions,
          triggers: content.triggers,
          status: content.status,
          protected: content.protected,
        }),
      );
      const insertedDefinition = await client.query<SkillRow>(
        `INSERT INTO skill_definitions (
           id, key, name, description, status, current_version,
           created_by_principal_id, created_at, updated_at
         ) VALUES (
           $1, $2, 'Project Reporting',
           '项目日报、周报和进度报告的事实约束 Skill。',
           'active', 1, $3, NOW(), NOW()
         )
         RETURNING id, current_version`,
        [skillId, PROJECT_REPORTING_SKILL_KEY, actorPrincipalId],
      );
      definition = insertedDefinition.rows[0]!;
      await client.query(
        `INSERT INTO skill_versions (
           id, skill_id, version, digest, publisher_principal_id,
           trust_level, instructions, manifest, permissions, triggers,
           status, protected, created_at
         ) VALUES (
           $1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
           $9::jsonb, $10, $11, NOW()
         )`,
        [
          randomUUID(),
          definition.id,
          digest,
          actorPrincipalId,
          content.trustLevel,
          content.instructions,
          JSON.stringify(content.manifest),
          JSON.stringify(content.permissions),
          JSON.stringify(content.triggers),
          content.status,
          content.protected,
        ],
      );
    }
    const version = await client.query<SkillVersionRow>(
      `SELECT id, version, digest
       FROM skill_versions
       WHERE skill_id = $1 AND version = $2 AND status = 'published'`,
      [definition.id, definition.current_version],
    );
    const row = version.rows[0];
    if (row === undefined) {
      throw new ProjectAiPmRepositoryError(
        "project_ai_pm_provision_failed",
        "Project Reporting Skill current version is unavailable",
      );
    }
    return { skillId: definition.id, versionId: row.id, ...row };
  }

  private async ensureProjectPmTemplate(
    client: PoolClient,
    project: ProjectRow,
    actorPrincipalId: string,
  ): Promise<ProjectPmTemplateDescriptor> {
    const name = `Project PM · ${project.code}`.slice(0, 120);
    const definition = teammateDefinitionSchema.parse({
      ...PROJECT_PM_TEMPLATE,
      name,
    });
    const existing = await client.query<TemplateRow>(
      `SELECT id, current_version
       FROM teammate_templates
       WHERE project_id = $1
         AND protected = TRUE
         AND lower(definition ->> 'name') = lower($2)
         AND status <> 'archived'
       LIMIT 1`,
      [project.id, name],
    );
    let template = existing.rows[0];
    if (template === undefined) {
      const inserted = await client.query<TemplateRow>(
        `INSERT INTO teammate_templates (
           id, project_id, workspace_id, scope, owner_principal_id, status,
           protected, current_version, definition, created_by,
           created_at, updated_at
         ) VALUES (
           $1, $2::uuid, $2::text, 'personal', $3, 'active', TRUE, 1,
           $4::jsonb, $3,
           NOW(), NOW()
         )
         RETURNING id, current_version`,
        [
          randomUUID(),
          project.id,
          actorPrincipalId,
          JSON.stringify(definition),
        ],
      );
      template = inserted.rows[0]!;
      await client.query(
        `INSERT INTO teammate_template_versions (
           id, template_id, project_id, version, definition,
           content_digest, created_by, created_at
         ) VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, NOW())`,
        [
          randomUUID(),
          template.id,
          project.id,
          JSON.stringify(definition),
          sha256(JSON.stringify(definition)),
          actorPrincipalId,
        ],
      );
    }
    const version = await client.query<TemplateVersionRow>(
      `SELECT id, version
       FROM teammate_template_versions
       WHERE template_id = $1 AND version = $2`,
      [template.id, template.current_version],
    );
    const row = version.rows[0];
    if (row === undefined) {
      throw new ProjectAiPmRepositoryError(
        "project_ai_pm_provision_failed",
        "Project PM template version is unavailable",
      );
    }
    return { id: template.id, versionId: row.id, version: row.version };
  }

  private async ensureRuntimeProfile(
    client: PoolClient,
    projectId: string,
    actorPrincipalId: string,
    requestedRuntimeId: string | undefined,
  ): Promise<{
    readonly runtimeProfileId: string;
    readonly runtimeProfileKind: "builtin" | "external";
    readonly externalRuntimeId: string | null;
    readonly agentRuntimeKind: "fake" | "codex-jsonl" | "plain-text";
  }> {
    if (requestedRuntimeId === undefined) {
      return {
        runtimeProfileId: `builtin:project-ai-pm:${projectId}`,
        runtimeProfileKind: "builtin",
        externalRuntimeId: null,
        agentRuntimeKind: "fake",
      };
    }
    const runtime = await client.query<{
      id: string;
      protocol: "codex-jsonl" | "plain-text";
      status: string;
      visibility: "platform" | "owner";
      owner_id: string;
    }>(
      `SELECT id, protocol, status, visibility, owner_id
       FROM external_runtimes
       WHERE id = $1`,
      [requestedRuntimeId],
    );
    const row = runtime.rows[0];
    if (
      row === undefined ||
      row.status !== "active" ||
      (row.visibility !== "platform" && row.owner_id !== actorPrincipalId)
    ) {
      throw new ProjectAiPmRepositoryError(
        "project_ai_pm_runtime_invalid",
        "The requested Runtime Profile is not active or accessible",
      );
    }
    return {
      runtimeProfileId: row.id,
      runtimeProfileKind: "external",
      externalRuntimeId: row.id,
      agentRuntimeKind: row.protocol,
    };
  }

  private async ensureAgentPrincipal(
    client: PoolClient,
    projectId: string,
  ): Promise<string> {
    const principalId = `principal-ai-pm-${projectId}`;
    await client.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES (
         $1, 'ai', 'Project AI PM', 'active', 'system', 'agent',
         1, NOW(), NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [principalId],
    );
    const principal = await client.query<{ kind: string; status: string }>(
      "SELECT kind, status FROM principals WHERE id = $1",
      [principalId],
    );
    if (
      principal.rows[0]?.kind !== "ai" ||
      principal.rows[0]?.status !== "active"
    ) {
      throw new ProjectAiPmRepositoryError(
        "project_ai_pm_provision_failed",
        "Project AI PM Principal is unavailable",
      );
    }
    await client.query(
      `INSERT INTO principal_aliases (
         id, principal_id, alias_type, alias_value, status, created_at,
         updated_at
       ) VALUES ($1, $2, 'teammate', $3, 'active', NOW(), NOW())
       ON CONFLICT (alias_type, alias_value) DO NOTHING`,
      [randomUUID(), principalId, `project-ai-pm:${projectId}`],
    );
    await client.query(
      `INSERT INTO principal_aliases (
         id, principal_id, alias_type, alias_value, status, created_at,
         updated_at
       ) VALUES ($1, $2, 'runtime-profile', $3, 'active', NOW(), NOW())
       ON CONFLICT (alias_type, alias_value) DO NOTHING`,
      [
        randomUUID(),
        principalId,
        `project-ai-pm-runtime:${projectId}`,
      ],
    );
    return principalId;
  }

  private async ensureAgent(
    client: PoolClient,
    project: ProjectRow,
    actorPrincipalId: string,
    agentPrincipalId: string,
    runtimeKind: "fake" | "codex-jsonl" | "plain-text",
  ): Promise<AgentRow> {
    const existing = await client.query<AgentRow>(
      "SELECT id FROM agents WHERE principal_id = $1 LIMIT 1",
      [agentPrincipalId],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0];
    const inserted = await client.query<AgentRow>(
      `INSERT INTO agents (
         id, name, description, runtime_kind, status,
         soul, scenarios, goals, tools, source, owner_id, version,
         principal_id, created_at, updated_at
       ) VALUES (
         $1, $2, '项目受保护 AI PM Agent', $3, 'active',
         $4, '[]'::jsonb, $5::jsonb, $6::jsonb, 'platform', $7, 1, $8,
         NOW(), NOW()
       )
       RETURNING id`,
      [
        randomUUID(),
        `Project AI PM · ${project.code}`.slice(0, 160),
        runtimeKind,
        PROJECT_PM_TEMPLATE.soul,
        JSON.stringify(PROJECT_PM_TEMPLATE.goals),
        JSON.stringify(PROJECT_PM_TEMPLATE.tools),
        actorPrincipalId,
        agentPrincipalId,
      ],
    );
    return inserted.rows[0]!;
  }

  private async ensureRuntimeBinding(
    client: PoolClient,
    agentId: string,
    actorPrincipalId: string,
    runtimeId: string | null,
  ): Promise<void> {
    if (runtimeId === null) return;
    const binding = await client.query<{ id: string }>(
      "SELECT id FROM agent_runtime_bindings WHERE agent_id = $1 AND status = 'active'",
      [agentId],
    );
    if (binding.rows[0] !== undefined) return;
    await client.query(
      `INSERT INTO agent_runtime_bindings (
         id, agent_id, runtime_id, execution_mode, status, revision,
         bound_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'external', 'active', 1, $4, NOW(), NOW())`,
      [randomUUID(), agentId, runtimeId, actorPrincipalId],
    );
  }

  private async ensureTeammate(
    client: PoolClient,
    project: ProjectRow,
    actorPrincipalId: string,
    template: ProjectPmTemplateDescriptor,
    agentId: string,
    agentPrincipalId: string,
  ): Promise<TeammateRow> {
    const existing = await client.query<TeammateRow>(
      "SELECT id FROM teammates WHERE agent_id = $1",
      [agentId],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0];
    const inserted = await client.query<TeammateRow>(
      `INSERT INTO teammates (
         id, project_id, workspace_id, template_id, template_version_id,
         template_version, agent_id, ai_principal_id, owner_principal_id,
         name, status, version, auto_execute, created_by, created_at,
         updated_at
       ) VALUES (
         $1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $9, 'active',
         1, FALSE,
         $8, NOW(), NOW()
       )
       RETURNING id`,
      [
        randomUUID(),
        project.id,
        template.id,
        template.versionId,
        template.version,
        agentId,
        agentPrincipalId,
        actorPrincipalId,
        `Project AI PM · ${project.code}`.slice(0, 120),
      ],
    );
    return inserted.rows[0]!;
  }

  private async ensureProjectMember(
    client: PoolClient,
    projectId: string,
    actorPrincipalId: string,
    agentId: string,
    agentPrincipalId: string,
    roleId: string,
  ): Promise<MemberRow> {
    let member = (
      await client.query<MemberRow>(
        `SELECT id
         FROM project_members
         WHERE project_id = $1
           AND kind = 'agent'
           AND (actor_id = $2 OR principal_id = $3)
         LIMIT 1`,
        [projectId, agentId, agentPrincipalId],
      )
    ).rows[0];
    if (member === undefined) {
      member = (
        await client.query<MemberRow>(
          `INSERT INTO project_members (
             id, project_id, kind, actor_id, principal_id, name,
             responsibility, status, is_owner, created_at, updated_at
           ) VALUES (
             $1, $2, 'agent', $3, $4, 'Project AI PM',
             '项目运营与汇报；不具备成员或角色管理权限。',
             'active', FALSE, NOW(), NOW()
           )
           RETURNING id`,
          [randomUUID(), projectId, agentId, agentPrincipalId],
        )
      ).rows[0]!;
    } else {
      await client.query(
        `UPDATE project_members
         SET principal_id = $3, status = 'active', updated_at = NOW()
         WHERE project_id = $1 AND id = $2`,
        [projectId, member.id, agentPrincipalId],
      );
    }
    await client.query(
      `INSERT INTO project_member_roles (project_member_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [member.id, roleId],
    );
    await this.authorization.syncProjectMemberGrantsWithClient(
      client,
      projectId,
      member.id,
      actorPrincipalId,
    );
    return member;
  }

  private async ensureSkillInstallation(
    client: PoolClient,
    actorPrincipalId: string,
    skill: ProjectReportingSkillDescriptor,
  ): Promise<InstallationRow> {
    const inserted = await client.query<InstallationRow>(
      `INSERT INTO skill_installations (
         id, principal_id, skill_id, version_id, status, revision,
         installed_by_principal_id, installed_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', 1, $2, NOW(), NOW())
       ON CONFLICT (principal_id, skill_id) DO UPDATE
       SET
         version_id = EXCLUDED.version_id,
         status = 'active',
         revision = skill_installations.revision + 1,
         updated_at = NOW()
       RETURNING id`,
      [randomUUID(), actorPrincipalId, skill.skillId, skill.versionId],
    );
    return inserted.rows[0]!;
  }

  private async ensureSkillBinding(
    client: PoolClient,
    template: ProjectPmTemplateDescriptor,
    actorPrincipalId: string,
    skill: ProjectReportingSkillDescriptor,
    installationId: string,
  ): Promise<BindingRow> {
    const inserted = await client.query<BindingRow>(
      `INSERT INTO teammate_template_skill_bindings (
         id, template_id, skill_id, skill_version_id, installation_id,
         required, enabled, mode, scenes, bound_by_principal_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, TRUE, TRUE, 'required',
         '["task-execution"]'::jsonb, $6, NOW(), NOW()
       )
       ON CONFLICT (template_id, skill_id) DO UPDATE
       SET
         skill_version_id = EXCLUDED.skill_version_id,
         installation_id = EXCLUDED.installation_id,
         enabled = TRUE,
         mode = 'required',
         scenes = '["task-execution"]'::jsonb,
         updated_at = NOW()
       RETURNING id`,
      [
        randomUUID(),
        template.id,
        skill.skillId,
        skill.versionId,
        installationId,
        actorPrincipalId,
      ],
    );
    return inserted.rows[0]!;
  }
}
