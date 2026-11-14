import { createHash, randomUUID } from "node:crypto";
import type {
  BindTemplateSkillInput,
  EffectiveSkill,
  EffectiveSkillsProjection,
  InstallSkillInput,
  RunSkillSnapshot,
  SkillAuditEvent,
  SkillDefinition,
  SkillDetail,
  SkillInstallation,
  SkillSource,
  SkillTrustLevel,
  SkillVersion,
  SkillVersionContentValue,
  SkillVersionStatus,
  TeammateInstanceSkillExtension,
  TeammateTemplateSkillBinding,
} from "@pluginmax/contracts";
import {
  canonicalSkillJson,
  PLATFORM_SKILL_SAFETY_RULES,
  skillVersionDigestPayload,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface SkillDefinitionRow {
  id: string;
  key: string;
  name: string;
  description: string;
  status: SkillDefinition["status"];
  current_version: number;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface SkillVersionRow {
  id: string;
  skill_id: string;
  version: number;
  digest: string;
  publisher_principal_id: string;
  trust_level: SkillTrustLevel;
  instructions: string;
  manifest: Record<string, unknown>;
  permissions: string[];
  triggers: string[];
  status: SkillVersionStatus;
  protected: boolean;
  created_at: Date;
}

interface SkillInstallationRow {
  id: string;
  principal_id: string;
  skill_id: string;
  version_id: string;
  status: SkillInstallation["status"];
  revision: number;
  installed_by_principal_id: string;
  installed_at: Date;
  updated_at: Date;
}

interface TemplateBindingRow {
  id: string;
  template_id: string;
  skill_id: string;
  skill_version_id: string;
  installation_id: string;
  required: boolean;
  enabled: boolean;
  bound_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface InstanceExtensionRow {
  id: string;
  teammate_id: string;
  skill_id: string;
  skill_version_id: string;
  installation_id: string;
  enabled: boolean;
  added_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface EffectiveSkillRow extends SkillVersionRow {
  skill_key: string;
  skill_name: string;
  required?: boolean;
}

interface TeammateSkillScopeRow {
  id: string;
  template_id: string;
  template_version_id: string;
}

interface RunSkillSnapshotRow {
  run_id: string;
  teammate_id: string | null;
  template_id: string | null;
  template_version_id: string | null;
  platform_safety_rules: RunSkillSnapshot["platformSafetyRules"];
  skills: RunSkillSnapshot["skills"];
  snapshot_digest: string;
  captured_at: Date;
}

interface SkillAuditRow {
  id: string;
  seq: string;
  resource_type: SkillAuditEvent["resourceType"];
  resource_id: string;
  kind: SkillAuditEvent["kind"];
  actor_principal_id: string;
  summary: string;
  data: Record<string, unknown>;
  created_at: Date;
}

type Queryable = Pick<Database, "query">;

export class SkillRepositoryError extends Error {
  constructor(
    readonly code:
      | "skill_definition_not_found"
      | "skill_version_not_found"
      | "skill_version_conflict"
      | "skill_installation_not_found"
      | "skill_installation_inactive"
      | "skill_installation_required"
      | "skill_binding_not_found"
      | "skill_binding_conflict"
      | "skill_binding_required"
      | "skill_extension_not_found"
      | "skill_extension_conflict"
      | "skill_extension_required_shadow"
      | "skill_scope_mismatch"
      | "run_not_found",
    message: string,
  ) {
    super(message);
    this.name = "SkillRepositoryError";
  }
}

function definitionFromRow(row: SkillDefinitionRow): SkillDefinition {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: row.current_version,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function versionFromRow(row: SkillVersionRow): SkillVersion {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    digest: row.digest,
    publisherPrincipalId: row.publisher_principal_id,
    trustLevel: row.trust_level,
    instructions: row.instructions,
    manifest: row.manifest,
    permissions: row.permissions,
    triggers: row.triggers,
    status: row.status,
    protected: row.protected,
    createdAt: row.created_at.toISOString(),
  };
}

function installationFromRow(row: SkillInstallationRow): SkillInstallation {
  return {
    id: row.id,
    principalId: row.principal_id,
    skillId: row.skill_id,
    versionId: row.version_id,
    status: row.status,
    revision: row.revision,
    installedByPrincipalId: row.installed_by_principal_id,
    installedAt: row.installed_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function bindingFromRow(
  row: TemplateBindingRow,
): TeammateTemplateSkillBinding {
  return {
    id: row.id,
    templateId: row.template_id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    installationId: row.installation_id,
    required: row.required,
    enabled: row.enabled,
    boundByPrincipalId: row.bound_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function extensionFromRow(
  row: InstanceExtensionRow,
): TeammateInstanceSkillExtension {
  return {
    id: row.id,
    teammateId: row.teammate_id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    installationId: row.installation_id,
    enabled: row.enabled,
    addedByPrincipalId: row.added_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function snapshotFromRow(row: RunSkillSnapshotRow): RunSkillSnapshot {
  return {
    runId: row.run_id,
    teammateId: row.teammate_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    platformSafetyRules: row.platform_safety_rules,
    skills: row.skills,
    snapshotDigest: row.snapshot_digest,
    capturedAt: row.captured_at.toISOString(),
  };
}

function auditFromRow(row: SkillAuditRow): SkillAuditEvent {
  return {
    id: row.id,
    seq: Number(row.seq),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    kind: row.kind,
    actorPrincipalId: row.actor_principal_id,
    summary: row.summary,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function skillVersionDigest(input: {
  readonly skillId: string;
  readonly version: number;
  readonly publisherPrincipalId: string;
  readonly content: SkillVersionContentValue;
}): string {
  return sha256(
    skillVersionDigestPayload({
      skillId: input.skillId,
      version: input.version,
      publisherPrincipalId: input.publisherPrincipalId,
      trustLevel: input.content.trustLevel,
      instructions: input.content.instructions,
      manifest: input.content.manifest,
      permissions: input.content.permissions,
      triggers: input.content.triggers,
      status: input.content.status,
      protected: input.content.protected,
    }),
  );
}

export function effectiveSkillSnapshotDigest(input: {
  readonly platformSafetyRules: RunSkillSnapshot["platformSafetyRules"];
  readonly skills: readonly EffectiveSkill[];
}): string {
  return sha256(
    canonicalSkillJson({
      platformSafetyRules: input.platformSafetyRules,
      skills: input.skills,
    }),
  );
}

async function detailWithQuery(
  query: Queryable,
  skillId: string,
): Promise<SkillDetail> {
  const definition = await query.query<SkillDefinitionRow>(
    "SELECT * FROM skill_definitions WHERE id = $1",
    [skillId],
  );
  const row = definition.rows[0];
  if (row === undefined) {
    throw new SkillRepositoryError(
      "skill_definition_not_found",
      "Skill Definition not found",
    );
  }
  const versions = await query.query<SkillVersionRow>(
    `SELECT *
     FROM skill_versions
     WHERE skill_id = $1
     ORDER BY version DESC`,
    [skillId],
  );
  return {
    definition: definitionFromRow(row),
    versions: versions.rows.map(versionFromRow),
  };
}

async function appendAuditWithQuery(
  query: Queryable,
  input: {
    readonly resourceType: SkillAuditEvent["resourceType"];
    readonly resourceId: string;
    readonly kind: SkillAuditEvent["kind"];
    readonly actorPrincipalId: string;
    readonly summary: string;
    readonly data?: Record<string, unknown>;
  },
): Promise<void> {
  await query.query(
    `INSERT INTO skill_audit_events (
       id, resource_type, resource_id, kind, actor_principal_id, summary,
       data, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
    [
      randomUUID(),
      input.resourceType,
      input.resourceId,
      input.kind,
      input.actorPrincipalId,
      input.summary,
      JSON.stringify(input.data ?? {}),
    ],
  );
}

async function requireInstallation(
  query: Queryable,
  input: {
    readonly principalId: string;
    readonly skillId: string;
    readonly versionId: string;
  },
): Promise<SkillInstallationRow> {
  const result = await query.query<SkillInstallationRow>(
    `SELECT *
     FROM skill_installations
     WHERE principal_id = $1
       AND skill_id = $2
       AND version_id = $3
       AND status = 'active'`,
    [input.principalId, input.skillId, input.versionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SkillRepositoryError(
      "skill_installation_inactive",
      "The Skill version is not actively installed for this Principal",
    );
  }
  return row;
}

async function teammateScope(
  query: Queryable,
  teammateId: string,
): Promise<TeammateSkillScopeRow> {
  const result = await query.query<TeammateSkillScopeRow>(
    `SELECT id, template_id, template_version_id
     FROM teammates
     WHERE id = $1`,
    [teammateId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SkillRepositoryError(
      "skill_scope_mismatch",
      "AI Teammate not found",
    );
  }
  return row;
}

async function listBindingsWithQuery(
  query: Queryable,
  templateId: string,
): Promise<TeammateTemplateSkillBinding[]> {
  const result = await query.query<TemplateBindingRow>(
    `SELECT *
     FROM teammate_template_skill_bindings
     WHERE template_id = $1
     ORDER BY required DESC, created_at, id`,
    [templateId],
  );
  return result.rows.map(bindingFromRow);
}

async function listExtensionsWithQuery(
  query: Queryable,
  teammateId: string,
): Promise<TeammateInstanceSkillExtension[]> {
  const result = await query.query<InstanceExtensionRow>(
    `SELECT *
     FROM teammate_instance_skill_extensions
     WHERE teammate_id = $1
     ORDER BY created_at, id`,
    [teammateId],
  );
  return result.rows.map(extensionFromRow);
}

async function resolveEffectiveWithQuery(
  query: Queryable,
  teammateId: string,
): Promise<EffectiveSkillsProjection> {
  const teammate = await teammateScope(query, teammateId);
  const [bindings, extensions] = await Promise.all([
    listBindingsWithQuery(query, teammate.template_id),
    listExtensionsWithQuery(query, teammate.id),
  ]);
  const bindingSkills = await query.query<EffectiveSkillRow>(
    `SELECT
       version.*,
       definition.key AS skill_key,
       definition.name AS skill_name,
       binding.required
     FROM teammate_template_skill_bindings AS binding
     JOIN skill_definitions AS definition
       ON definition.id = binding.skill_id
     JOIN skill_versions AS version
       ON version.id = binding.skill_version_id
      AND version.skill_id = binding.skill_id
     JOIN skill_installations AS installation
       ON installation.id = binding.installation_id
      AND installation.status = 'active'
      AND installation.skill_id = binding.skill_id
      AND installation.version_id = binding.skill_version_id
     WHERE binding.template_id = $1
       AND binding.enabled = TRUE
       AND version.status <> 'revoked'
     ORDER BY binding.required DESC, definition.key, binding.created_at`,
    [teammate.template_id],
  );
  const extensionSkills = await query.query<EffectiveSkillRow>(
    `SELECT
       version.*,
       definition.key AS skill_key,
       definition.name AS skill_name,
       FALSE AS required
     FROM teammate_instance_skill_extensions AS extension
     JOIN skill_definitions AS definition
       ON definition.id = extension.skill_id
     JOIN skill_versions AS version
       ON version.id = extension.skill_version_id
      AND version.skill_id = extension.skill_id
     JOIN skill_installations AS installation
       ON installation.id = extension.installation_id
      AND installation.status = 'active'
      AND installation.skill_id = extension.skill_id
      AND installation.version_id = extension.skill_version_id
     WHERE extension.teammate_id = $1
       AND extension.enabled = TRUE
       AND version.status <> 'revoked'
     ORDER BY definition.key, extension.created_at`,
    [teammate.id],
  );

  const seen = new Set<string>();
  const skills: EffectiveSkill[] = [];
  const add = (row: EffectiveSkillRow, source: SkillSource): void => {
    if (seen.has(row.skill_id)) return;
    seen.add(row.skill_id);
    skills.push({
      skillId: row.skill_id,
      key: row.skill_key,
      name: row.skill_name,
      versionId: row.id,
      version: row.version,
      digest: row.digest,
      publisherPrincipalId: row.publisher_principal_id,
      trustLevel: row.trust_level,
      instructions: row.instructions,
      manifest: row.manifest,
      permissions: row.permissions,
      triggers: row.triggers,
      status: row.status,
      protected: row.protected,
      source,
      grantsAuthorization: false,
    });
  };

  for (const row of bindingSkills.rows) {
    add(row, row.required ? "required_template" : "default_template");
  }
  for (const row of extensionSkills.rows) {
    add(row, "instance_extension");
  }

  return {
    teammateId: teammate.id,
    templateId: teammate.template_id,
    templateVersionId: teammate.template_version_id,
    platformSafetyRules: [...PLATFORM_SKILL_SAFETY_RULES],
    skills,
    bindings,
    extensions,
  };
}

export async function captureRunSkillSnapshotWithClient(
  client: PoolClient,
  runId: string,
): Promise<RunSkillSnapshot> {
  const existing = await client.query<RunSkillSnapshotRow>(
    "SELECT * FROM run_skill_snapshots WHERE run_id = $1",
    [runId],
  );
  if (existing.rows[0] !== undefined) {
    return snapshotFromRow(existing.rows[0]);
  }
  const run = await client.query<{
    teammate_id: string | null;
    actor_principal_id: string | null;
  }>(
    `SELECT
       teammate.id AS teammate_id,
       COALESCE(
         run.initiated_by_principal_id,
         run.agent_principal_id,
         run.execution_envelope_snapshot ->> 'agentPrincipalId',
         agent.principal_id,
         teammate.ai_principal_id,
         (
           SELECT principal.id
           FROM principals AS principal
           WHERE principal.kind = 'human' AND principal.status = 'active'
           ORDER BY principal.id
           LIMIT 1
         )
       ) AS actor_principal_id
     FROM runs AS run
     LEFT JOIN agents AS agent ON agent.id = run.agent_id
     LEFT JOIN teammates AS teammate ON teammate.agent_id = run.agent_id
     WHERE run.id = $1`,
    [runId],
  );
  if (run.rows[0] === undefined) {
    throw new SkillRepositoryError("run_not_found", "Run not found");
  }
  const teammateId = run.rows[0].teammate_id;
  const actorPrincipalId = run.rows[0].actor_principal_id;
  const projection =
    teammateId === null
      ? undefined
      : await resolveEffectiveWithQuery(client, teammateId);
  const platformSafetyRules = [...PLATFORM_SKILL_SAFETY_RULES];
  const skills = projection?.skills ?? [];
  const snapshotDigest = effectiveSkillSnapshotDigest({
    platformSafetyRules,
    skills,
  });
  const inserted = await client.query<RunSkillSnapshotRow>(
    `INSERT INTO run_skill_snapshots (
       run_id, teammate_id, template_id, template_version_id,
       platform_safety_rules, skills, snapshot_digest, captured_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NOW())
     ON CONFLICT (run_id) DO NOTHING
     RETURNING *`,
    [
      runId,
      projection?.teammateId ?? null,
      projection?.templateId ?? null,
      projection?.templateVersionId ?? null,
      JSON.stringify(platformSafetyRules),
      JSON.stringify(skills),
      snapshotDigest,
    ],
  );
  const row =
    inserted.rows[0] ??
    (
      await client.query<RunSkillSnapshotRow>(
        "SELECT * FROM run_skill_snapshots WHERE run_id = $1",
        [runId],
      )
    ).rows[0];
  if (row === undefined) {
    throw new Error("Run Skill Snapshot insert was not observable");
  }
  if (inserted.rows[0] !== undefined && actorPrincipalId !== null) {
    await appendAuditWithQuery(client, {
      resourceType: "run",
      resourceId: runId,
      kind: "run.skills.snapshot",
      actorPrincipalId,
      summary: `固化 ${skills.length} 个 Effective Skills`,
      data: {
        teammateId,
        snapshotDigest,
        skillIds: skills.map((skill) => skill.skillId),
      },
    });
  }
  return snapshotFromRow(row);
}

export class SkillRepository {
  constructor(private readonly database: Database) {}

  listDefinitions(
    principalId: string,
    includeInactive = false,
  ): Promise<SkillDefinition[]> {
    return this.database
      .query<SkillDefinitionRow>(
        `SELECT *
         FROM skill_definitions
         WHERE ($1::boolean OR status = 'active')
           AND (
             EXISTS (
               SELECT 1
               FROM skill_versions AS version
               WHERE version.skill_id = skill_definitions.id
                 AND version.trust_level <> 'private'
             )
             OR EXISTS (
               SELECT 1
               FROM skill_versions AS version
               WHERE version.skill_id = skill_definitions.id
                 AND version.trust_level = 'private'
                 AND version.publisher_principal_id = $2
             )
           )
         ORDER BY key`,
        [includeInactive, principalId],
      )
      .then((result) => result.rows.map(definitionFromRow));
  }

  getDetail(skillId: string): Promise<SkillDetail> {
    return detailWithQuery(this.database, skillId);
  }

  async createDefinition(input: {
    readonly key: string;
    readonly name: string;
    readonly description: string;
    readonly actorPrincipalId: string;
    readonly content: SkillVersionContentValue;
  }): Promise<SkillDetail> {
    const skillId = randomUUID();
    const versionId = randomUUID();
    const digest = skillVersionDigest({
      skillId,
      version: 1,
      publisherPrincipalId: input.actorPrincipalId,
      content: input.content,
    });
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO skill_definitions (
           id, key, name, description, status, current_version,
           created_by_principal_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', 1, $5, NOW(), NOW())`,
        [
          skillId,
          input.key,
          input.name,
          input.description,
          input.actorPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO skill_versions (
           id, skill_id, version, digest, publisher_principal_id,
           trust_level, instructions, manifest, permissions, triggers,
           status, protected, created_at
         ) VALUES (
           $1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
           $10, $11, NOW()
         )`,
        [
          versionId,
          skillId,
          digest,
          input.actorPrincipalId,
          input.content.trustLevel,
          input.content.instructions,
          JSON.stringify(input.content.manifest),
          JSON.stringify(input.content.permissions),
          JSON.stringify(input.content.triggers),
          input.content.status,
          input.content.protected,
        ],
      );
      await appendAuditWithQuery(client, {
        resourceType: "skill",
        resourceId: skillId,
        kind: "skill.definition.created",
        actorPrincipalId: input.actorPrincipalId,
        summary: `创建 Skill「${input.name}」`,
        data: {
          key: input.key,
          trustLevel: input.content.trustLevel,
          protected: input.content.protected,
        },
      });
      await appendAuditWithQuery(client, {
        resourceType: "skill",
        resourceId: skillId,
        kind: "skill.version.published",
        actorPrincipalId: input.actorPrincipalId,
        summary: "发布 Skill 版本 1",
        data: { versionId, version: 1, digest },
      });
      return detailWithQuery(client, skillId);
    });
  }

  async addVersion(input: {
    readonly skillId: string;
    readonly actorPrincipalId: string;
    readonly expectedCurrentVersion: number;
    readonly content: SkillVersionContentValue;
  }): Promise<SkillDetail> {
    return this.database.transaction(async (client) => {
      const current = await client.query<SkillDefinitionRow>(
        "SELECT * FROM skill_definitions WHERE id = $1 FOR UPDATE",
        [input.skillId],
      );
      const definition = current.rows[0];
      if (definition === undefined) {
        throw new SkillRepositoryError(
          "skill_definition_not_found",
          "Skill Definition not found",
        );
      }
      if (definition.current_version !== input.expectedCurrentVersion) {
        throw new SkillRepositoryError(
          "skill_version_conflict",
          "Skill Definition was revised by another request",
        );
      }
      const version = definition.current_version + 1;
      const versionId = randomUUID();
      const digest = skillVersionDigest({
        skillId: input.skillId,
        version,
        publisherPrincipalId: input.actorPrincipalId,
        content: input.content,
      });
      await client.query(
        `INSERT INTO skill_versions (
           id, skill_id, version, digest, publisher_principal_id,
           trust_level, instructions, manifest, permissions, triggers,
           status, protected, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
           $11, $12, NOW()
         )`,
        [
          versionId,
          input.skillId,
          version,
          digest,
          input.actorPrincipalId,
          input.content.trustLevel,
          input.content.instructions,
          JSON.stringify(input.content.manifest),
          JSON.stringify(input.content.permissions),
          JSON.stringify(input.content.triggers),
          input.content.status,
          input.content.protected,
        ],
      );
      await client.query(
        `UPDATE skill_definitions
         SET current_version = $2, updated_at = NOW()
         WHERE id = $1`,
        [input.skillId, version],
      );
      await appendAuditWithQuery(client, {
        resourceType: "skill",
        resourceId: input.skillId,
        kind: "skill.version.published",
        actorPrincipalId: input.actorPrincipalId,
        summary: `发布 Skill 版本 ${version}`,
        data: { versionId, version, digest },
      });
      return detailWithQuery(client, input.skillId);
    });
  }

  async listInstallations(
    principalId: string,
  ): Promise<SkillInstallation[]> {
    const result = await this.database.query<SkillInstallationRow>(
      `SELECT *
       FROM skill_installations
       WHERE principal_id = $1
       ORDER BY updated_at DESC, id`,
      [principalId],
    );
    return result.rows.map(installationFromRow);
  }

  async getInstallation(id: string): Promise<SkillInstallation | undefined> {
    const result = await this.database.query<SkillInstallationRow>(
      "SELECT * FROM skill_installations WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : installationFromRow(row);
  }

  async install(input: {
    readonly actorPrincipalId: string;
    readonly value: InstallSkillInput;
  }): Promise<SkillInstallation> {
    return this.database.transaction(async (client) => {
      const version = await client.query<SkillVersionRow>(
        `SELECT *
         FROM skill_versions
         WHERE id = $1 AND skill_id = $2`,
        [input.value.versionId, input.value.skillId],
      );
      if (version.rows[0] === undefined) {
        throw new SkillRepositoryError(
          "skill_version_not_found",
          "Skill version does not belong to the Skill Definition",
        );
      }
      const inserted = await client.query<SkillInstallationRow>(
        `INSERT INTO skill_installations (
           id, principal_id, skill_id, version_id, status, revision,
           installed_by_principal_id, installed_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', 1, $2, NOW(), NOW())
         ON CONFLICT (principal_id, skill_id) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          input.actorPrincipalId,
          input.value.skillId,
          input.value.versionId,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        await appendAuditWithQuery(client, {
          resourceType: "skill",
          resourceId: input.value.skillId,
          kind: "skill.installed",
          actorPrincipalId: input.actorPrincipalId,
          summary: "安装 Skill",
          data: {
            installationId: inserted.rows[0].id,
            versionId: input.value.versionId,
          },
        });
        return installationFromRow(inserted.rows[0]);
      }
      const current = await client.query<SkillInstallationRow>(
        `SELECT *
         FROM skill_installations
         WHERE principal_id = $1 AND skill_id = $2
         FOR UPDATE`,
        [input.actorPrincipalId, input.value.skillId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw new SkillRepositoryError(
          "skill_installation_not_found",
          "Skill installation disappeared during install",
        );
      }
      if (
        row.version_id === input.value.versionId &&
        row.status === "active"
      ) {
        return installationFromRow(row);
      }
      const updated = await client.query<SkillInstallationRow>(
        `UPDATE skill_installations
         SET version_id = $3,
             status = 'active',
             revision = revision + 1,
             installed_by_principal_id = $4,
             updated_at = NOW()
         WHERE principal_id = $1 AND skill_id = $2
         RETURNING *`,
        [
          input.actorPrincipalId,
          input.value.skillId,
          input.value.versionId,
          input.actorPrincipalId,
        ],
      );
      await appendAuditWithQuery(client, {
        resourceType: "skill",
        resourceId: input.value.skillId,
        kind: "skill.installed",
        actorPrincipalId: input.actorPrincipalId,
        summary: "更新 Skill 安装版本",
        data: {
          installationId: updated.rows[0]!.id,
          versionId: input.value.versionId,
        },
      });
      return installationFromRow(updated.rows[0]!);
    });
  }

  async uninstall(input: {
    readonly installationId: string;
    readonly actorPrincipalId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<SkillInstallationRow>(
        `SELECT *
         FROM skill_installations
         WHERE id = $1 AND principal_id = $2
         FOR UPDATE`,
        [input.installationId, input.actorPrincipalId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new SkillRepositoryError(
          "skill_installation_not_found",
          "Skill installation not found",
        );
      }
      const required = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM teammate_template_skill_bindings
           WHERE installation_id = $1 AND required = TRUE
         ) AS exists`,
        [input.installationId],
      );
      if (required.rows[0]?.exists) {
        throw new SkillRepositoryError(
          "skill_installation_required",
          "A required Skill installation cannot be removed",
        );
      }
      await client.query("DELETE FROM skill_installations WHERE id = $1", [
        input.installationId,
      ]);
      await appendAuditWithQuery(client, {
        resourceType: "skill",
        resourceId: row.skill_id,
        kind: "skill.uninstalled",
        actorPrincipalId: input.actorPrincipalId,
        summary: "卸载 Skill",
        data: { installationId: input.installationId },
      });
    });
  }

  async listTemplateBindings(
    templateId: string,
  ): Promise<TeammateTemplateSkillBinding[]> {
    return listBindingsWithQuery(this.database, templateId);
  }

  async bindTemplateSkill(input: {
    readonly templateId: string;
    readonly actorPrincipalId: string;
    readonly value: BindTemplateSkillInput;
  }): Promise<TeammateTemplateSkillBinding> {
    return this.database.transaction(async (client) => {
      const installation = await requireInstallation(client, {
        principalId: input.actorPrincipalId,
        skillId: input.value.skillId,
        versionId: input.value.versionId,
      });
      const inserted = await client.query<TemplateBindingRow>(
        `INSERT INTO teammate_template_skill_bindings (
           id, template_id, skill_id, skill_version_id, installation_id,
           required, enabled, bound_by_principal_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         ON CONFLICT (template_id, skill_id) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          input.templateId,
          input.value.skillId,
          input.value.versionId,
          installation.id,
          input.value.required ?? false,
          input.value.enabled ?? true,
          input.actorPrincipalId,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        await appendAuditWithQuery(client, {
          resourceType: "template",
          resourceId: input.templateId,
          kind: "skills.bound",
          actorPrincipalId: input.actorPrincipalId,
          summary: "绑定 Template Skill",
          data: {
            bindingId: inserted.rows[0].id,
            skillId: input.value.skillId,
            versionId: input.value.versionId,
            required: input.value.required ?? false,
          },
        });
        return bindingFromRow(inserted.rows[0]);
      }
      const existing = await client.query<TemplateBindingRow>(
        `SELECT *
         FROM teammate_template_skill_bindings
         WHERE template_id = $1 AND skill_id = $2
         FOR UPDATE`,
        [input.templateId, input.value.skillId],
      );
      const row = existing.rows[0]!;
      if (
        row.skill_version_id === input.value.versionId &&
        row.required === (input.value.required ?? false) &&
        row.enabled === (input.value.enabled ?? true)
      ) {
        return bindingFromRow(row);
      }
      throw new SkillRepositoryError(
        "skill_binding_conflict",
        "A different binding already exists for this Skill",
      );
    });
  }

  async unbindTemplateSkill(input: {
    readonly templateId: string;
    readonly bindingId: string;
    readonly actorPrincipalId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<TemplateBindingRow>(
        `SELECT *
         FROM teammate_template_skill_bindings
         WHERE id = $1 AND template_id = $2
         FOR UPDATE`,
        [input.bindingId, input.templateId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new SkillRepositoryError(
          "skill_binding_not_found",
          "Template Skill binding not found",
        );
      }
      if (row.required) {
        throw new SkillRepositoryError(
          "skill_binding_required",
          "Required Skill bindings cannot be removed",
        );
      }
      await client.query(
        "DELETE FROM teammate_template_skill_bindings WHERE id = $1",
        [input.bindingId],
      );
      await appendAuditWithQuery(client, {
        resourceType: "template",
        resourceId: input.templateId,
        kind: "skills.unbound",
        actorPrincipalId: input.actorPrincipalId,
        summary: "解绑 Template Skill",
        data: {
          bindingId: input.bindingId,
          skillId: row.skill_id,
        },
      });
    });
  }

  async listInstanceExtensions(
    teammateId: string,
  ): Promise<TeammateInstanceSkillExtension[]> {
    return listExtensionsWithQuery(this.database, teammateId);
  }

  async addInstanceExtension(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly value: {
      readonly skillId: string;
      readonly versionId: string;
      readonly enabled?: boolean;
    };
  }): Promise<TeammateInstanceSkillExtension> {
    return this.database.transaction(async (client) => {
      const teammate = await teammateScope(client, input.teammateId);
      const shadow = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM teammate_template_skill_bindings
           WHERE template_id = $1
             AND skill_id = $2
             AND required = TRUE
         ) AS exists`,
        [teammate.template_id, input.value.skillId],
      );
      if (shadow.rows[0]?.exists) {
        throw new SkillRepositoryError(
          "skill_extension_required_shadow",
          "Instance extensions cannot shadow a required template Skill",
        );
      }
      const installation = await requireInstallation(client, {
        principalId: input.actorPrincipalId,
        skillId: input.value.skillId,
        versionId: input.value.versionId,
      });
      const inserted = await client.query<InstanceExtensionRow>(
        `INSERT INTO teammate_instance_skill_extensions (
           id, teammate_id, skill_id, skill_version_id, installation_id,
           enabled, added_by_principal_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (teammate_id, skill_id) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          input.teammateId,
          input.value.skillId,
          input.value.versionId,
          installation.id,
          input.value.enabled ?? true,
          input.actorPrincipalId,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        await appendAuditWithQuery(client, {
          resourceType: "teammate",
          resourceId: input.teammateId,
          kind: "skills.extension.added",
          actorPrincipalId: input.actorPrincipalId,
          summary: "追加 Instance Skill extension",
          data: {
            extensionId: inserted.rows[0].id,
            skillId: input.value.skillId,
            versionId: input.value.versionId,
          },
        });
        return extensionFromRow(inserted.rows[0]);
      }
      const existing = await client.query<InstanceExtensionRow>(
        `SELECT *
         FROM teammate_instance_skill_extensions
         WHERE teammate_id = $1 AND skill_id = $2
         FOR UPDATE`,
        [input.teammateId, input.value.skillId],
      );
      const row = existing.rows[0]!;
      if (
        row.skill_version_id === input.value.versionId &&
        row.enabled === (input.value.enabled ?? true)
      ) {
        return extensionFromRow(row);
      }
      throw new SkillRepositoryError(
        "skill_extension_conflict",
        "A different instance extension already exists for this Skill",
      );
    });
  }

  async removeInstanceExtension(input: {
    readonly teammateId: string;
    readonly extensionId: string;
    readonly actorPrincipalId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<InstanceExtensionRow>(
        `SELECT *
         FROM teammate_instance_skill_extensions
         WHERE id = $1 AND teammate_id = $2
         FOR UPDATE`,
        [input.extensionId, input.teammateId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new SkillRepositoryError(
          "skill_extension_not_found",
          "Instance Skill extension not found",
        );
      }
      await client.query(
        "DELETE FROM teammate_instance_skill_extensions WHERE id = $1",
        [input.extensionId],
      );
      await appendAuditWithQuery(client, {
        resourceType: "teammate",
        resourceId: input.teammateId,
        kind: "skills.extension.removed",
        actorPrincipalId: input.actorPrincipalId,
        summary: "移除 Instance Skill extension",
        data: {
          extensionId: input.extensionId,
          skillId: row.skill_id,
        },
      });
    });
  }

  resolveEffectiveSkills(
    teammateId: string,
  ): Promise<EffectiveSkillsProjection> {
    return resolveEffectiveWithQuery(this.database, teammateId);
  }

  async getRunSnapshot(runId: string): Promise<RunSkillSnapshot | undefined> {
    const result = await this.database.query<RunSkillSnapshotRow>(
      "SELECT * FROM run_skill_snapshots WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : snapshotFromRow(row);
  }

  async listAudit(input: {
    readonly resourceType: SkillAuditEvent["resourceType"];
    readonly resourceId: string;
  }): Promise<SkillAuditEvent[]> {
    const result = await this.database.query<SkillAuditRow>(
      `SELECT *
       FROM skill_audit_events
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY seq`,
      [input.resourceType, input.resourceId],
    );
    return result.rows.map(auditFromRow);
  }
}
