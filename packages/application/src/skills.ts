import type {
  AddInstanceSkillExtensionInput,
  BindTemplateSkillInput,
  CreateSkillDefinitionInput,
  CreateSkillVersionInput,
  EffectiveSkillsProjection,
  InstallSkillInput,
  RunSkillSnapshot,
  SkillAuditEvent,
  SkillDefinition,
  SkillDetail,
  SkillInstallation,
  SkillVersionContentValue,
  TeammateInstanceSkillExtension,
  TeammateTemplate,
  TeammateTemplateSkillBinding,
} from "@pluginmax/contracts";
import {
  addInstanceSkillExtensionInputSchema,
  bindTemplateSkillInputSchema,
  canonicalSkillJson,
  createSkillDefinitionInputSchema,
  createSkillVersionInputSchema,
  installSkillInputSchema,
  SKILLS_PLATFORM_FLAG,
} from "@pluginmax/contracts";
import {
  SkillRepositoryError,
  type PlatformRepositories,
  type ScopedAuthorizationPermission,
} from "@pluginmax/database";
import { ApplicationError } from "./errors.js";

const RESERVED_MANIFEST_KEYS = new Set([
  "authorization",
  "permissionsoverride",
  "platformsafetyrules",
  "required",
  "safety",
  "safetyrules",
  "source",
  "system",
  "systemprompt",
]);

const SECRET_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "token",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function assertNoSecrets(value: unknown, path = "content"): void {
  if (typeof value === "string") {
    if (
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
      /\bsk-[a-zA-Z0-9_-]{8,}\b/.test(value) ||
      /\bBearer\s+[a-zA-Z0-9._~+/=-]{8,}\b/i.test(value)
    ) {
      throw new ApplicationError(
        "skill_secret_forbidden",
        `Skill content at ${path} appears to contain a secret`,
        400,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(normalizedKey(key))) {
      throw new ApplicationError(
        "skill_secret_forbidden",
        `Skill content cannot carry credential field ${path}.${key}`,
        400,
      );
    }
    assertNoSecrets(item, `${path}.${key}`);
  }
}

function validateManifest(
  value: unknown,
  path = "manifest",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateManifest(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_MANIFEST_KEYS.has(normalizedKey(key))) {
      throw new ApplicationError(
        "skill_safety_override_forbidden",
        `Skill manifest cannot override platform field ${path}.${key}`,
        400,
      );
    }
    validateManifest(item, `${path}.${key}`);
  }
}

function validateContent(content: SkillVersionContentValue): void {
  validateManifest(content.manifest);
  assertNoSecrets(content.instructions, "instructions");
  assertNoSecrets(content.manifest, "manifest");
  if (canonicalSkillJson(content.manifest).length > 200_000) {
    throw new ApplicationError(
      "skill_manifest_too_large",
      "Skill manifest exceeds the platform limit",
      400,
    );
  }
}

function translateRepositoryError(error: unknown): never {
  if (!(error instanceof SkillRepositoryError)) throw error;
  const statusCode =
    error.code === "skill_definition_not_found" ||
    error.code === "skill_version_not_found" ||
    error.code === "skill_installation_not_found" ||
    error.code === "skill_binding_not_found" ||
    error.code === "skill_extension_not_found"
      ? 404
      : error.code === "skill_version_conflict" ||
          error.code === "skill_binding_conflict" ||
          error.code === "skill_extension_conflict" ||
          error.code === "skill_installation_inactive" ||
          error.code === "skill_installation_required" ||
          error.code === "skill_binding_required" ||
          error.code === "skill_extension_required_shadow"
        ? 409
        : 403;
  throw new ApplicationError(error.code, error.message, statusCode);
}

export class SkillApplicationService {
  constructor(private readonly repositories: PlatformRepositories) {}

  private async requireActivePrincipal(principalId: string): Promise<void> {
    const principal =
      await this.repositories.authorization.getPrincipal(principalId);
    if (principal === undefined || principal.status !== "active") {
      throw new ApplicationError(
        "principal_inactive",
        "An active Principal is required",
        403,
      );
    }
  }

  private async requireHumanPrincipal(principalId: string): Promise<void> {
    await this.requireActivePrincipal(principalId);
    const principal =
      await this.repositories.authorization.getPrincipal(principalId);
    if (principal?.kind !== "human") {
      throw new ApplicationError(
        "skill_installation_principal_invalid",
        "Skills must be installed by a human account Principal",
        403,
      );
    }
  }

  private async authSource(
    principalId: string,
  ): Promise<"bearer" | "local-development"> {
    const principal =
      await this.repositories.authorization.getPrincipal(principalId);
    return principal?.source === "local" ? "local-development" : "bearer";
  }

  private async requireProjectPermission(
    projectId: string,
    principalId: string,
    permission: ScopedAuthorizationPermission,
  ): Promise<void> {
    const decision = await this.repositories.authorization.authorizeProject({
      principalId,
      authSource: await this.authSource(principalId),
      projectId,
      permission,
    });
    if (!decision.allowed) {
      throw new ApplicationError(
        decision.reason === "project_archived"
          ? "project_archived"
          : "forbidden",
        decision.reason === "project_archived"
          ? "Archived projects cannot be modified"
          : "Project permission is required",
        decision.reason === "project_archived" ? 409 : 403,
        {
          reason: decision.reason ?? "permission_missing",
          projectId,
          permission,
        },
      );
    }
  }

  private async assertEnabled(projectId?: string | null): Promise<void> {
    if (
      !(await this.repositories.featureFlags.isEnabled(
        SKILLS_PLATFORM_FLAG,
        projectId,
      ))
    ) {
      throw new ApplicationError(
        "skills_platform_disabled",
        "The Skill platform is disabled",
        409,
      );
    }
  }

  private async templateForManage(
    templateId: string,
    actorPrincipalId: string,
    administrator: boolean,
  ): Promise<TeammateTemplate> {
    const template = await this.repositories.teammates.getTemplate(templateId);
    if (template === undefined) {
      throw new ApplicationError(
        "teammate_template_not_found",
        "AI Teammate template not found",
        404,
      );
    }
    await this.requireActivePrincipal(actorPrincipalId);
    const allowed =
      template.scope === "platform"
        ? administrator
        : template.ownerPrincipalId === actorPrincipalId;
    if (!allowed) {
      throw new ApplicationError(
        "teammate_template_forbidden",
        "Only the template owner or platform administrator can manage Skills",
        403,
      );
    }
    return template;
  }

  private async teammateForManage(
    teammateId: string,
    actorPrincipalId: string,
    administrator: boolean,
  ) {
    const teammate =
      await this.repositories.teammates.getTeammate(teammateId);
    if (teammate === undefined) {
      throw new ApplicationError(
        "teammate_not_found",
        "AI Teammate not found",
        404,
      );
    }
    await this.requireProjectPermission(
      teammate.projectId,
      actorPrincipalId,
      "write",
    );
    if (teammate.ownerPrincipalId !== actorPrincipalId && !administrator) {
      throw new ApplicationError(
        "teammate_forbidden",
        "Only the AI Teammate owner or platform administrator can manage it",
        403,
      );
    }
    return teammate;
  }

  private async teammateForRead(
    teammateId: string,
    actorPrincipalId: string,
  ) {
    const teammate =
      await this.repositories.teammates.getTeammate(teammateId);
    if (teammate === undefined) {
      throw new ApplicationError(
        "teammate_not_found",
        "AI Teammate not found",
        404,
      );
    }
    await this.requireProjectPermission(
      teammate.projectId,
      actorPrincipalId,
      "read",
    );
    return teammate;
  }

  private async assertCanPublish(
    input: {
      readonly actorPrincipalId: string;
      readonly administrator: boolean;
      readonly content: SkillVersionContentValue;
    },
  ): Promise<void> {
    if (
      (input.content.trustLevel === "official" ||
        input.content.trustLevel === "verified" ||
        input.content.protected) &&
      !input.administrator
    ) {
      throw new ApplicationError(
        "skill_publish_forbidden",
        "Official, verified, or protected Skills require platform administration",
        403,
      );
    }
    if (
      input.content.protected &&
      input.content.trustLevel === "private"
    ) {
      throw new ApplicationError(
        "skill_publish_forbidden",
        "A protected Skill cannot use the private trust level",
        403,
      );
    }
    await this.requireHumanPrincipal(input.actorPrincipalId);
  }

  async listDefinitions(
    actorPrincipalId: string,
    includeInactive = false,
  ): Promise<SkillDefinition[]> {
    await this.requireActivePrincipal(actorPrincipalId);
    return this.repositories.skills.listDefinitions(
      actorPrincipalId,
      includeInactive,
    );
  }

  async getDefinition(input: {
    readonly skillId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<SkillDetail> {
    await this.requireActivePrincipal(input.actorPrincipalId);
    const detail = await this.repositories.skills.getDetail(input.skillId);
    const canReadPrivate =
      input.administrator ||
      detail.definition.createdByPrincipalId === input.actorPrincipalId;
    const versions = detail.versions.filter(
      (version) =>
        canReadPrivate ||
        version.trustLevel !== "private" ||
        version.publisherPrincipalId === input.actorPrincipalId,
    );
    if (versions.length === 0) {
      throw new ApplicationError(
        "skill_definition_forbidden",
        "This private Skill is not visible to the current Principal",
        403,
      );
    }
    return { definition: detail.definition, versions };
  }

  async createDefinition(input: {
    readonly value: CreateSkillDefinitionInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<SkillDetail> {
    await this.assertEnabled();
    const parsed = createSkillDefinitionInputSchema.parse(input.value);
    await this.assertCanPublish({
      actorPrincipalId: input.actorPrincipalId,
      administrator: input.administrator,
      content: parsed.content,
    });
    validateContent(parsed.content);
    try {
      return await this.repositories.skills.createDefinition({
        key: parsed.key,
        name: parsed.name,
        description: parsed.description,
        actorPrincipalId: input.actorPrincipalId,
        content: parsed.content,
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApplicationError(
          "skill_key_conflict",
          "A Skill Definition with this key already exists",
          409,
        );
      }
      translateRepositoryError(error);
    }
  }

  async addVersion(input: {
    readonly skillId: string;
    readonly value: CreateSkillVersionInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<SkillDetail> {
    await this.assertEnabled();
    const parsed = createSkillVersionInputSchema.parse(input.value);
    const detail = await this.repositories.skills.getDetail(input.skillId);
    if (
      detail.definition.createdByPrincipalId !== input.actorPrincipalId &&
      !input.administrator
    ) {
      throw new ApplicationError(
        "skill_publish_forbidden",
        "Only the Skill publisher or platform administrator can publish a version",
        403,
      );
    }
    if (detail.definition.status === "archived") {
      throw new ApplicationError(
        "skill_definition_archived",
        "Archived Skills cannot publish new versions",
        409,
      );
    }
    await this.assertCanPublish({
      actorPrincipalId: input.actorPrincipalId,
      administrator: input.administrator,
      content: parsed.content,
    });
    validateContent(parsed.content);
    try {
      return await this.repositories.skills.addVersion({
        skillId: input.skillId,
        actorPrincipalId: input.actorPrincipalId,
        expectedCurrentVersion: parsed.expectedCurrentVersion,
        content: parsed.content,
      });
    } catch (error) {
      translateRepositoryError(error);
    }
  }

  async listInstallations(
    actorPrincipalId: string,
  ): Promise<SkillInstallation[]> {
    await this.requireActivePrincipal(actorPrincipalId);
    return this.repositories.skills.listInstallations(actorPrincipalId);
  }

  async install(input: {
    readonly value: InstallSkillInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<SkillInstallation> {
    await this.assertEnabled();
    const parsed = installSkillInputSchema.parse(input.value);
    await this.requireHumanPrincipal(input.actorPrincipalId);
    const detail = await this.repositories.skills.getDetail(parsed.skillId);
    const version = detail.versions.find(
      (candidate) => candidate.id === parsed.versionId,
    );
    if (version === undefined) {
      throw new ApplicationError(
        "skill_version_not_found",
        "Skill version not found",
        404,
      );
    }
    if (version.status !== "published") {
      throw new ApplicationError(
        "skill_version_not_installable",
        "Only a published Skill version can be installed",
        409,
      );
    }
    if (
      version.trustLevel === "private" &&
      version.publisherPrincipalId !== input.actorPrincipalId &&
      !input.administrator
    ) {
      throw new ApplicationError(
        "skill_installation_forbidden",
        "Private Skills can only be installed by their publisher",
        403,
      );
    }
    try {
      return await this.repositories.skills.install({
        actorPrincipalId: input.actorPrincipalId,
        value: parsed,
      });
    } catch (error) {
      translateRepositoryError(error);
    }
  }

  async uninstall(input: {
    readonly installationId: string;
    readonly actorPrincipalId: string;
  }): Promise<void> {
    await this.assertEnabled();
    try {
      await this.repositories.skills.uninstall(input);
    } catch (error) {
      translateRepositoryError(error);
    }
  }

  listTemplateBindings(
    templateId: string,
    actorPrincipalId: string,
    administrator: boolean,
  ): Promise<TeammateTemplateSkillBinding[]> {
    return this.templateForManage(
      templateId,
      actorPrincipalId,
      administrator,
    ).then(() => this.repositories.skills.listTemplateBindings(templateId));
  }

  async bindTemplateSkill(input: {
    readonly templateId: string;
    readonly value: BindTemplateSkillInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<TeammateTemplateSkillBinding> {
    await this.assertEnabled();
    await this.templateForManage(
      input.templateId,
      input.actorPrincipalId,
      input.administrator,
    );
    const parsed = bindTemplateSkillInputSchema.parse(input.value);
    if (parsed.required && parsed.enabled === false) {
      throw new ApplicationError(
        "required_skill_cannot_be_disabled",
        "A required Skill must remain enabled",
        409,
      );
    }
    if (
      parsed.required &&
      parsed.mode !== undefined &&
      parsed.mode !== "required"
    ) {
      throw new ApplicationError(
        "required_skill_mode_conflict",
        "A required Skill binding must use mode=required",
        409,
      );
    }
    try {
      return await this.repositories.skills.bindTemplateSkill({
        templateId: input.templateId,
        actorPrincipalId: input.actorPrincipalId,
        value: parsed,
      });
    } catch (error) {
      translateRepositoryError(error);
    }
  }

  async unbindTemplateSkill(input: {
    readonly templateId: string;
    readonly bindingId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<void> {
    await this.assertEnabled();
    await this.templateForManage(
      input.templateId,
      input.actorPrincipalId,
      input.administrator,
    );
    try {
      await this.repositories.skills.unbindTemplateSkill(input);
    } catch (error) {
      translateRepositoryError(error);
    }
  }

  async getEffectiveSkills(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
  }): Promise<EffectiveSkillsProjection> {
    await this.teammateForRead(input.teammateId, input.actorPrincipalId);
    return this.repositories.skills.resolveEffectiveSkills(input.teammateId);
  }

  listInstanceExtensions(
    teammateId: string,
    actorPrincipalId: string,
  ): Promise<TeammateInstanceSkillExtension[]> {
    return this.teammateForRead(teammateId, actorPrincipalId).then(() =>
      this.repositories.skills.listInstanceExtensions(teammateId),
    );
  }

  async addInstanceExtension(input: {
    readonly teammateId: string;
    readonly value: AddInstanceSkillExtensionInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<TeammateInstanceSkillExtension> {
    await this.assertEnabled();
    await this.teammateForManage(
      input.teammateId,
      input.actorPrincipalId,
      input.administrator,
    );
    const parsed = addInstanceSkillExtensionInputSchema.parse(input.value);
    try {
      return await this.repositories.skills.addInstanceExtension({
        teammateId: input.teammateId,
        actorPrincipalId: input.actorPrincipalId,
        value: parsed,
      });
    } catch (error) {
      translateRepositoryError(error);
    }
  }

  async removeInstanceExtension(input: {
    readonly teammateId: string;
    readonly extensionId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<void> {
    await this.assertEnabled();
    await this.teammateForManage(
      input.teammateId,
      input.actorPrincipalId,
      input.administrator,
    );
    try {
      await this.repositories.skills.removeInstanceExtension(input);
    } catch (error) {
      translateRepositoryError(error);
    }
  }

  async getRunSnapshot(
    runId: string,
    actorPrincipalId: string,
  ): Promise<RunSkillSnapshot> {
    await this.requireActivePrincipal(actorPrincipalId);
    const run = await this.repositories.runs.get(runId);
    if (run === undefined) {
      throw new ApplicationError("run_not_found", "Run not found", 404);
    }
    if (run.projectId !== null) {
      await this.requireProjectPermission(
        run.projectId,
        actorPrincipalId,
        "read",
      );
    }
    const snapshot = await this.repositories.skills.getRunSnapshot(runId);
    if (snapshot === undefined) {
      throw new ApplicationError(
        "run_skill_snapshot_not_found",
        "Run has no Skill Snapshot",
        404,
      );
    }
    return snapshot;
  }

  async listAudit(input: {
    readonly skillId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<SkillAuditEvent[]> {
    const detail = await this.repositories.skills.getDetail(input.skillId);
    if (
      detail.definition.createdByPrincipalId !== input.actorPrincipalId &&
      !input.administrator
    ) {
      throw new ApplicationError(
        "skill_audit_forbidden",
        "Only the Skill publisher or platform administrator can read its audit",
        403,
      );
    }
    return this.repositories.skills.listAudit({
      resourceType: "skill",
      resourceId: input.skillId,
    });
  }
}
